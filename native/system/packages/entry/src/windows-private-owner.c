/*
 * Windows x64 Node-API 8 private-storage resource owner.
 * Environment cleanup releases real handles without executing JavaScript.
 * Native finalizers additionally release unreachable capabilities during life.
 * Unsettled I/O retains its entire native owner in a process-lifetime quarantine;
 * cancellation is a request, never evidence that kernel buffer use has stopped.
 */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0602
#endif
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stddef.h>
#include <stdlib.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#if !defined(_WIN64) || !defined(_M_X64)
#error This resource owner requires Windows x64.
#endif
#if NAPI_VERSION != 8
#error This resource owner requires stable Node-API 8.
#endif

#define OWNER_LIMIT 4096
#define FILE_LIMIT 16384
#define READ_LIMIT 1048576u
#define WRITE_LIMIT 65536u
#define DESCRIPTOR_LIMIT 65536u
#define NAME_LIMIT 255u
#define ENUM_LIMIT 100000u
/* These are refusal bounds, not workload tuning: two finite waits then quarantine. */
#define SETTLE_MILLISECONDS 1000u
#define PS_PENDING ((NTSTATUS)0x00000103L)
#define PS_NO_MORE_FILES ((NTSTATUS)0x80000006L)
#define PS_END_OF_FILE ((NTSTATUS)0xC0000011L)
#define PS_SUCCESS ((NTSTATUS)0)

_Static_assert(sizeof(void *) == 8, "Windows x64 pointer width");
_Static_assert(sizeof(IO_STATUS_BLOCK) == 16, "Windows IO_STATUS_BLOCK width");
_Static_assert(offsetof(IO_STATUS_BLOCK, Information) == 8, "Windows IO_STATUS_BLOCK information");
_Static_assert(sizeof(FILE_ID_INFO) == 24, "Windows full file identity width");
_Static_assert(sizeof(OVERLAPPED) == 32, "Windows OVERLAPPED width");
_Static_assert(sizeof(OBJECT_ATTRIBUTES) == 48, "Windows OBJECT_ATTRIBUTES width");
_Static_assert(sizeof(UNICODE_STRING) == 16, "Windows UNICODE_STRING width");

typedef NTSTATUS (NTAPI *create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES,
  PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *query_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *rw_fn)(HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK,
  PVOID, ULONG, PLARGE_INTEGER, PULONG);
typedef NTSTATUS (NTAPI *directory_fn)(HANDLE, HANDLE, PVOID, PVOID,
  PIO_STATUS_BLOCK, PVOID, ULONG, ULONG, BOOLEAN, PUNICODE_STRING, BOOLEAN);

typedef struct owner owner;
typedef struct owned_file owned_file;
typedef struct io_context io_context;
typedef struct {
  const char *operation;
  const char *code;
  DWORD value;
  bool nt;
  bool win32;
  bool cleanup_failed;
  bool pending;
} failure;

struct owned_file {
  owner *owner;
  owned_file *next;
  HANDLE handle;
  /* A failed close is retired once; this value is never submitted to CloseHandle again. */
  HANDLE unconfirmed_handle;
  OVERLAPPED lease;
  bool locked;
  bool exposed;
  bool handle_counted;
};

struct io_context {
  owner *owner;
  io_context *next;
  IO_STATUS_BLOCK ios;
  OVERLAPPED overlapped;
  UNICODE_STRING name;
  OBJECT_ATTRIBUTES attributes;
  LARGE_INTEGER offset;
  HANDLE token;
  HANDLE unconfirmed_token;
  HANDLE process;
  HANDLE unconfirmed_process;
  PSECURITY_DESCRIPTOR descriptor;
  bool descriptor_release_attempted;
  bool pending;
  DWORD count;
  DWORD needed;
  size_t capacity;
  unsigned char data[];
};

struct owner {
  napi_env env;
  owned_file *files;
  io_context *contexts;
  owner *quarantine_next;
  size_t references;
  size_t file_count;
  size_t live_file_count;
  bool cleaned;
  bool quarantined;
  bool pending;
};

static struct {
  volatile LONG64 open_files;
  volatile LONG64 open_tokens;
  volatile LONG64 open_processes;
  volatile LONG64 local_blocks;
  volatile LONG64 heap_blocks;
  volatile LONG64 pending_contexts;
  volatile LONG64 unconfirmed_releases;
  volatile LONG64 owners;
  volatile LONG64 file_records;
} counters;
static const napi_type_tag owner_tag = { UINT64_C(0x8b02816610404327), UINT64_C(0xa08c09eb73d63161) };
static const napi_type_tag file_tag = { UINT64_C(0x06c267579bfc4e2f), UINT64_C(0xbeb68f1d343b16a6) };
static INIT_ONCE initialization = INIT_ONCE_STATIC_INIT;
static SRWLOCK quarantine_lock = SRWLOCK_INIT;
static owner *quarantined_owners;
static create_fn nt_create;
static query_fn nt_query;
static query_fn nt_volume;
static query_fn nt_set;
static rw_fn nt_read;
static rw_fn nt_write;
static directory_fn nt_directory;
static bool initialized;

static void *allocate(size_t size) {
  void *result = calloc(1, size);
  if (result != NULL) InterlockedIncrement64(&counters.heap_blocks);
  return result;
}

static void deallocate(void *pointer) {
  if (pointer == NULL) return;
  free(pointer);
  InterlockedDecrement64(&counters.heap_blocks);
}

static failure fail(const char *operation, const char *code) {
  failure result = { 0 };
  result.operation = operation;
  result.code = code;
  return result;
}

static failure win_failure(const char *operation, DWORD value) {
  failure result = fail(operation, value == ERROR_SHARING_VIOLATION ? "sharing"
    : value == ERROR_LOCK_VIOLATION ? "busy"
    : value == ERROR_FILE_NOT_FOUND || value == ERROR_PATH_NOT_FOUND ? "not-found"
    : value == ERROR_ALREADY_EXISTS || value == ERROR_FILE_EXISTS ? "collision" : "native");
  result.value = value;
  result.win32 = true;
  return result;
}

static failure nt_failure(const char *operation, NTSTATUS status) {
  DWORD value = (DWORD)status;
  failure result = fail(operation, value == 0xc0000034u || value == 0xc000003au ? "not-found"
    : value == 0xc0000035u ? "collision" : value == 0xc0000043u ? "sharing"
    : value == 0xc0000003u || value == 0xc00000bbu ? "unsupported" : "native");
  result.value = value;
  result.nt = true;
  return result;
}

/* Preserve the primary exception even when a later native retirement is unconfirmed. */
static napi_value throw_failure(napi_env env, failure error) {
  napi_value message, exception, value;
  bool pending = false;
  if (napi_is_exception_pending(env, &pending) != napi_ok) return NULL;
  if (pending) {
    if (napi_get_and_clear_last_exception(env, &exception) != napi_ok) return NULL;
  } else {
    if (napi_create_string_utf8(env, error.operation, NAPI_AUTO_LENGTH, &message) != napi_ok
      || napi_create_error(env, NULL, message, &exception) != napi_ok) return NULL;
  }
#define ERROR_FIELD(call, name) do { \
  if ((call) != napi_ok || napi_set_named_property(env, exception, name, value) != napi_ok) { \
    (void)napi_throw(env, exception); return NULL; \
  } \
} while (0)
  ERROR_FIELD(napi_create_string_utf8(env, error.operation, NAPI_AUTO_LENGTH, &value), "operation");
  ERROR_FIELD(napi_create_string_utf8(env, error.code, NAPI_AUTO_LENGTH, &value), "code");
  if (error.nt) ERROR_FIELD(napi_create_uint32(env, error.value, &value), "nativeStatus");
  if (error.win32) ERROR_FIELD(napi_create_uint32(env, error.value, &value), "win32Code");
  ERROR_FIELD(napi_get_boolean(env, error.cleanup_failed, &value), "cleanupFailed");
  ERROR_FIELD(napi_get_boolean(env, error.pending, &value), "pending");
#undef ERROR_FIELD
  (void)napi_throw(env, exception);
  return NULL;
}

static void quarantine(owner *state, bool pending) {
  state->pending = state->pending || pending;
  if (state->quarantined) return;
  state->quarantined = true;
  InterlockedIncrement64(&counters.unconfirmed_releases);
  AcquireSRWLockExclusive(&quarantine_lock);
  state->quarantine_next = quarantined_owners;
  quarantined_owners = state;
  ReleaseSRWLockExclusive(&quarantine_lock);
}

static void owner_release(owner *state) {
  if (--state->references == 0 && !state->quarantined) {
    InterlockedDecrement64(&counters.owners);
    deallocate(state);
  }
}

static bool retire_file(owned_file *file, failure *error) {
  owner *state = file->owner;
  HANDLE handle;
  if (file->handle == NULL && file->unconfirmed_handle == NULL) return true;
  if (state->quarantined) {
    if (error != NULL) {
      error->cleanup_failed = true;
      error->pending = state->pending;
    }
    return false;
  }
  handle = file->handle;
  file->handle = NULL;
  if (handle == NULL) return true;
  if (!CloseHandle(handle)) {
    DWORD code = GetLastError();
    file->unconfirmed_handle = handle;
    quarantine(state, false);
    if (error != NULL) {
      if (error->operation == NULL) *error = win_failure("CloseHandle", code);
      error->cleanup_failed = true;
    }
    return false;
  }
  file->locked = false;
  if (file->handle_counted) {
    file->handle_counted = false;
    state->live_file_count--;
    InterlockedDecrement64(&counters.open_files);
  }
  return true;
}

static void unlink_file(owned_file *file) {
  owner *state = file->owner;
  owned_file **cursor = &state->files;
  while (*cursor != NULL && *cursor != file) cursor = &(*cursor)->next;
  if (*cursor == file) *cursor = file->next;
  state->file_count--;
  InterlockedDecrement64(&counters.file_records);
  deallocate(file);
  owner_release(state);
}

static void finalize_file(napi_env env, void *data, void *hint) {
  owned_file *file = data;
  (void)env;
  (void)hint;
  (void)retire_file(file, NULL);
  if (!file->owner->quarantined) unlink_file(file);
}

static void cleanup_owner(void *data) {
  owner *state = data;
  owned_file *file;
  state->cleaned = true;
  for (file = state->files; file != NULL; file = file->next) (void)retire_file(file, NULL);
  /* Synchronous callbacks cannot overlap this hook. Only quarantine may retain contexts. */
  owner_release(state);
}

static void finalize_owner(napi_env env, void *data, void *hint) {
  owner *state = data;
  owned_file *file;
  (void)hint;
  for (file = state->files; file != NULL; file = file->next) (void)retire_file(file, NULL);
  if (!state->cleaned) {
    /* During ordinary GC remove this hook; teardown hooks precede native finalizers. */
    if (napi_remove_env_cleanup_hook(env, cleanup_owner, state) == napi_ok) {
      state->cleaned = true;
      owner_release(state);
    } else {
      quarantine(state, false);
    }
  }
  owner_release(state);
}

static io_context *new_context(owner *state, size_t capacity, failure *error) {
  io_context *context = allocate(sizeof(*context) + capacity);
  if (context == NULL) {
    *error = fail("native allocation", "unavailable");
    return NULL;
  }
  context->owner = state;
  context->capacity = capacity;
  context->next = state->contexts;
  state->contexts = context;
  context->ios.Status = PS_PENDING;
  return context;
}

static bool release_token(io_context *context, failure *error) {
  HANDLE token = context->token;
  if (token == NULL) return true;
  context->token = NULL;
  if (!CloseHandle(token)) {
    DWORD code = GetLastError();
    context->unconfirmed_token = token;
    quarantine(context->owner, false);
    if (error->operation == NULL) *error = win_failure("CloseHandle token", code);
    error->cleanup_failed = true;
    return false;
  }
  InterlockedDecrement64(&counters.open_tokens);
  return true;
}

static bool release_process(io_context *context, failure *error) {
  HANDLE process = context->process;
  if (process == NULL) return true;
  context->process = NULL;
  if (!CloseHandle(process)) {
    DWORD code = GetLastError();
    context->unconfirmed_process = process;
    quarantine(context->owner, false);
    if (error->operation == NULL) *error = win_failure("CloseHandle process observation", code);
    error->cleanup_failed = true;
    return false;
  }
  InterlockedDecrement64(&counters.open_processes);
  return true;
}

static bool release_descriptor(io_context *context, failure *error) {
  if (context->descriptor == NULL) return true;
  if (context->descriptor_release_attempted) return false;
  context->descriptor_release_attempted = true;
  if (LocalFree(context->descriptor) != NULL) {
    DWORD code = GetLastError();
    quarantine(context->owner, false);
    if (error->operation == NULL) *error = win_failure("LocalFree security descriptor", code);
    error->cleanup_failed = true;
    return false;
  }
  context->descriptor = NULL;
  InterlockedDecrement64(&counters.local_blocks);
  return true;
}

static void release_context(io_context *context, failure *error) {
  owner *state = context->owner;
  io_context **cursor;
  if (state->quarantined) {
    error->cleanup_failed = true;
    error->pending = state->pending;
    return;
  }
  (void)release_token(context, error);
  (void)release_process(context, error);
  (void)release_descriptor(context, error);
  if (state->quarantined) return;
  cursor = &state->contexts;
  while (*cursor != context) cursor = &(*cursor)->next;
  *cursor = context->next;
  deallocate(context);
}

static bool complete_io(io_context *context, HANDLE handle, NTSTATUS status,
                        const char *operation, failure *error, NTSTATUS *result) {
  if (status != PS_PENDING) {
    *result = status;
    return true;
  }
  context->pending = true;
  InterlockedIncrement64(&counters.pending_contexts);
  if (handle != NULL && handle != INVALID_HANDLE_VALUE) {
    DWORD wait = WaitForSingleObject(handle, SETTLE_MILLISECONDS);
    if (wait == WAIT_OBJECT_0 && context->ios.Status != PS_PENDING) goto settled;
    /* No later call may start on this owner until this request is settled. */
    (void)CancelIoEx(handle, NULL);
    wait = WaitForSingleObject(handle, SETTLE_MILLISECONDS);
    if (wait == WAIT_OBJECT_0 && context->ios.Status != PS_PENDING) goto settled;
  }
  *error = nt_failure(operation, PS_PENDING);
  error->code = "unavailable";
  error->cleanup_failed = true;
  error->pending = true;
  quarantine(context->owner, true);
  return false;
settled:
  context->pending = false;
  InterlockedDecrement64(&counters.pending_contexts);
  *result = context->ios.Status;
  return true;
}

static bool call_succeeded(io_context *context, HANDLE handle, NTSTATUS status,
                           const char *operation, failure *error) {
  NTSTATUS result;
  if (!complete_io(context, handle, status, operation, error, &result)) return false;
  if (result != PS_SUCCESS) {
    *error = nt_failure(operation, result);
    return false;
  }
  return true;
}

static owner *arguments(napi_env env, napi_callback_info info, size_t expected,
                       napi_value *values, bool allow_quarantine, failure *error) {
  size_t count = expected;
  napi_value receiver;
  owner *state = NULL;
  bool tagged = false;
  if (napi_get_cb_info(env, info, &count, values, &receiver, NULL) != napi_ok || count != expected
    || napi_check_object_type_tag(env, receiver, &owner_tag, &tagged) != napi_ok || !tagged
    || napi_unwrap(env, receiver, (void **)&state) != napi_ok || state == NULL || state->env != env) {
    *error = fail("native owner arguments", "identity");
    return NULL;
  }
  if (state->cleaned) {
    *error = fail("native owner closed", "closed");
    return NULL;
  }
  if (state->quarantined && !allow_quarantine) {
    *error = fail("native owner completion uncertain", "unavailable");
    error->pending = state->pending;
    error->cleanup_failed = true;
    return NULL;
  }
  return state;
}

static owned_file *file_argument(napi_env env, napi_value value, owner *state,
                                 bool allow_closed, failure *error) {
  owned_file *file = NULL;
  bool tagged = false;
  if (napi_check_object_type_tag(env, value, &file_tag, &tagged) != napi_ok || !tagged
    || napi_get_value_external(env, value, (void **)&file) != napi_ok || file == NULL
    || file->owner != state) {
    *error = fail("native file owner", "identity");
    return NULL;
  }
  if (file->handle == NULL && !allow_closed) {
    *error = fail("native file closed", "closed");
    return NULL;
  }
  return file;
}

static bool uint_argument(napi_env env, napi_value value, uint32_t maximum, uint32_t *result) {
  double number;
  if (napi_get_value_double(env, value, &number) != napi_ok || !(number >= 0 && number <= maximum)
    || number != (uint32_t)number) return false;
  *result = (uint32_t)number;
  return true;
}

static bool string_argument(napi_env env, napi_value value, char *result, size_t capacity) {
  size_t length;
  if (napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok || length >= capacity) return false;
  return napi_get_value_string_utf8(env, value, result, capacity, &length) == napi_ok;
}

static bool bytes_argument(napi_env env, napi_value value, void **data, size_t *length) {
  bool typed = false;
  napi_typedarray_type type;
  napi_value buffer;
  size_t offset;
  if (napi_is_typedarray(env, value, &typed) != napi_ok || !typed) return false;
  return napi_get_typedarray_info(env, value, &type, length, data, &buffer, &offset) == napi_ok
    && type == napi_uint8_array && (*length == 0 || *data != NULL);
}

static bool name_argument(napi_env env, napi_value value, WCHAR *name, bool root, size_t *length) {
  size_t count, index;
  if (napi_get_value_string_utf16(env, value, NULL, 0, &count) != napi_ok
    || count == 0 || count > NAME_LIMIT
    || napi_get_value_string_utf16(env, value, (char16_t *)name, NAME_LIMIT + 1, length) != napi_ok
    || *length != count) return false;
  if (root) return count == 7 && name[0] == L'\\' && name[1] == L'?'
    && name[2] == L'?' && name[3] == L'\\' && ((name[4] >= L'A' && name[4] <= L'Z')
    || (name[4] >= L'a' && name[4] <= L'z')) && name[5] == L':' && name[6] == L'\\';
  if ((count == 1 && name[0] == L'.') || (count == 2 && name[0] == L'.' && name[1] == L'.')) return false;
  for (index = 0; index < count; index++) {
    WCHAR c = name[index];
    if (c == 0 || c == L'/' || c == L'\\' || c == L':' || c < 32) return false;
  }
  return true;
}

/* Validate every self-relative offset before Windows can follow caller-supplied bytes. */
static bool descriptor_valid(const unsigned char *bytes, size_t length) {
  SECURITY_DESCRIPTOR_RELATIVE sd;
  DWORD offsets[4];
  size_t index;
  if (length < sizeof(sd) || length > DESCRIPTOR_LIMIT) return false;
  memcpy(&sd, bytes, sizeof(sd));
  if (sd.Revision != SECURITY_DESCRIPTOR_REVISION || !(sd.Control & SE_SELF_RELATIVE)) return false;
  offsets[0] = sd.Owner; offsets[1] = sd.Group; offsets[2] = sd.Sacl; offsets[3] = sd.Dacl;
  for (index = 0; index < 4; index++) {
    size_t offset = offsets[index];
    if (offset == 0) continue;
    if ((offset & 3) != 0 || offset < sizeof(sd) || offset > length || length - offset < 8) return false;
    if (index < 2) {
      const unsigned char *sid = bytes + offset;
      if (sid[0] != SID_REVISION || sid[1] > SID_MAX_SUB_AUTHORITIES
        || 8u + 4u * sid[1] > length - offset) return false;
    } else {
      ACL acl;
      size_t cursor, ace;
      memcpy(&acl, bytes + offset, sizeof(acl));
      if ((acl.AclRevision != ACL_REVISION && acl.AclRevision != ACL_REVISION_DS)
        || acl.AclSize < sizeof(acl) || acl.AclSize > length - offset) return false;
      cursor = sizeof(acl);
      for (ace = 0; ace < acl.AceCount; ace++) {
        ACE_HEADER header;
        if (cursor > acl.AclSize || acl.AclSize - cursor < sizeof(header)) return false;
        memcpy(&header, bytes + offset + cursor, sizeof(header));
        if (header.AceSize < sizeof(header) || (header.AceSize & 3) != 0
          || header.AceSize > acl.AclSize - cursor) return false;
        cursor += header.AceSize;
      }
    }
  }
  return IsValidSecurityDescriptor((PSECURITY_DESCRIPTOR)bytes) != FALSE;
}

static napi_value result_or_error(napi_env env, io_context *context, failure error, napi_value result) {
  release_context(context, &error);
  return error.operation != NULL ? throw_failure(env, error) : result;
}

static napi_value owner_token_user(napi_env env, napi_callback_info info) {
  failure error = { 0 };
  owner *state = arguments(env, info, 0, NULL, false, &error);
  io_context *context;
  napi_value result = NULL;
  uintptr_t begin, sid;
  size_t length;
  DWORD code;
  BOOL opened;
  if (state == NULL) return throw_failure(env, error);
  context = new_context(state, DESCRIPTOR_LIMIT, &error);
  if (context == NULL) return throw_failure(env, error);
  opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &context->token);
  code = opened ? ERROR_SUCCESS : GetLastError();
  if (context->token == INVALID_HANDLE_VALUE) context->token = NULL;
  if (context->token != NULL) InterlockedIncrement64(&counters.open_tokens);
  if (opened) { error = fail("thread impersonation", "unsupported"); goto done; }
  if (code != ERROR_NO_TOKEN) { error = win_failure("OpenThreadToken", code); goto done; }
  if (context->token != NULL) { error = fail("OpenThreadToken unexpected acquisition", "native"); goto done; }
  opened = OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &context->token);
  code = opened ? ERROR_SUCCESS : GetLastError();
  if (context->token == INVALID_HANDLE_VALUE) context->token = NULL;
  if (context->token != NULL) InterlockedIncrement64(&counters.open_tokens);
  if (!opened) { error = win_failure("OpenProcessToken", code); goto done; }
  if (context->token == NULL) { error = fail("OpenProcessToken missing acquisition", "native"); goto done; }
  if (IsTokenRestricted(context->token)) { error = fail("restricted process token", "unsupported"); goto done; }
  if (GetTokenInformation(context->token, TokenUser, NULL, 0, &context->needed)) {
    error = fail("TokenUser size query", "native"); goto done;
  }
  code = GetLastError();
  if (code != ERROR_INSUFFICIENT_BUFFER) { error = win_failure("TokenUser size query", code); goto done; }
  if (context->needed < sizeof(TOKEN_USER) || context->needed > context->capacity) {
    error = fail("TokenUser bounds", "privacy"); goto done;
  }
  if (!GetTokenInformation(context->token, TokenUser, context->data, context->needed, &context->count)) {
    error = win_failure("TokenUser", GetLastError()); goto done;
  }
  begin = (uintptr_t)context->data;
  sid = (uintptr_t)((TOKEN_USER *)context->data)->User.Sid;
  if (context->count > context->needed || context->count > context->capacity || context->count < sizeof(TOKEN_USER)
    || sid < begin + sizeof(TOKEN_USER) || sid - begin > context->count - 8) {
    error = fail("TokenUser SID pointer", "privacy"); goto done;
  }
  length = 8u + 4u * ((unsigned char *)sid)[1];
  if (((unsigned char *)sid)[0] != SID_REVISION || ((unsigned char *)sid)[1] > SID_MAX_SUB_AUTHORITIES
    || length > context->count - (sid - begin) || !IsValidSid((PSID)sid)) {
    error = fail("TokenUser SID length", "privacy"); goto done;
  }
  if (!release_token(context, &error)) goto done;
  if (napi_create_buffer_copy(env, length, (const void *)sid, NULL, &result) != napi_ok)
    error = fail("TokenUser result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_open(napi_env env, napi_callback_info info) {
  napi_value values[5], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 5, values, false, &error);
  owned_file *parent = NULL, *file;
  io_context *context;
  WCHAR name[NAME_LIMIT + 1];
  size_t length, descriptor_length = 0, descriptor_offset;
  char kind[16], mode[16];
  bool root, creating, logging, created_staging = false;
  void *descriptor = NULL;
  napi_valuetype type;
  ACCESS_MASK access;
  ULONG share, options, disposition;
  NTSTATUS status;
  if (state == NULL) return throw_failure(env, error);
  if (napi_typeof(env, values[0], &type) != napi_ok) return throw_failure(env, fail("open parent", "identity"));
  root = type == napi_null;
  if (!root && (parent = file_argument(env, values[0], state, false, &error)) == NULL) return throw_failure(env, error);
  if (!string_argument(env, values[2], kind, sizeof(kind))
    || (strcmp(kind, "directory") != 0 && strcmp(kind, "file") != 0 && strcmp(kind, "any") != 0)
    || !string_argument(env, values[3], mode, sizeof(mode))
    || (strcmp(mode, "inspect") != 0 && strcmp(mode, "read") != 0 && strcmp(mode, "read-source") != 0
      && strcmp(mode, "create") != 0 && strcmp(mode, "lock") != 0 && strcmp(mode, "delete") != 0 && strcmp(mode, "log") != 0
      && strcmp(mode, "read-link") != 0)
    || !name_argument(env, values[1], name, root, &length)
    || (root && (strcmp(kind, "directory") != 0 || strcmp(mode, "inspect") != 0))
    || (strcmp(mode, "read-link") == 0 && strcmp(kind, "any") != 0))
    return throw_failure(env, fail("open arguments", "identity"));
  creating = strcmp(mode, "create") == 0;
  logging = strcmp(mode, "log") == 0;
  if (napi_typeof(env, values[4], &type) != napi_ok
    || ((creating || logging) && (!bytes_argument(env, values[4], &descriptor, &descriptor_length)
      || descriptor_length < 20 || descriptor_length > DESCRIPTOR_LIMIT))
    || (!(creating || logging) && type != napi_null))
    return throw_failure(env, fail("open security descriptor", "privacy"));
  if (state->live_file_count >= FILE_LIMIT) return throw_failure(env, fail("native file limit", "limit"));
  descriptor_offset = ((length + 1) * sizeof(WCHAR) + 7u) & ~(size_t)7u;
  context = new_context(state, descriptor_offset + descriptor_length, &error);
  if (context == NULL) return throw_failure(env, error);
  memcpy(context->data, name, length * sizeof(WCHAR));
  if (descriptor_length != 0) {
    memcpy(context->data + descriptor_offset, descriptor, descriptor_length);
    if (!descriptor_valid(context->data + descriptor_offset, descriptor_length)) {
      error = fail("open security descriptor bounds", "privacy");
      return result_or_error(env, context, error, NULL);
    }
  }
  file = allocate(sizeof(*file));
  if (file == NULL) return result_or_error(env, context, fail("native file allocation", "unavailable"), NULL);
  InterlockedIncrement64(&counters.file_records);
  file->owner = state;
  file->next = state->files;
  state->files = file;
  state->file_count++;
  state->references++;
  context->name.Length = (USHORT)(length * sizeof(WCHAR));
  context->name.MaximumLength = (USHORT)((length + 1) * sizeof(WCHAR));
  context->name.Buffer = (PWSTR)context->data;
  context->attributes.Length = (ULONG)sizeof(context->attributes);
  context->attributes.RootDirectory = parent == NULL ? NULL : parent->handle;
  context->attributes.ObjectName = &context->name;
  /* Only a retained-parent literal link leaf may omit OBJ_DONT_REPARSE; OPEN_REPARSE_POINT stays set. */
  context->attributes.Attributes = strcmp(mode, "read-link") == 0 ? 0x40 : 0x1040;
  if (descriptor_length != 0) context->attributes.SecurityDescriptor = context->data + descriptor_offset;
  access = 0x120080 | (strcmp(kind, "directory") == 0 ? 0x21
    : strcmp(mode, "read") == 0 || strcmp(mode, "read-source") == 0 ? 1 : strcmp(mode, "lock") == 0 ? 3 : 0)
    | (logging ? 0x40000000u : 0)
    | (creating ? 0x10000u | (strcmp(kind, "file") == 0 ? 3u : 0u) : strcmp(mode, "delete") == 0 ? 0x10000u : 0u);
  share = strcmp(mode, "lock") == 0 || strcmp(kind, "directory") == 0 ? 3
    : creating || strcmp(mode, "read-source") == 0 || strcmp(mode, "read-link") == 0 || logging ? 1 : strcmp(mode, "read") == 0 ? 5 : 7;
  options = 0x200020 | (strcmp(kind, "directory") == 0 ? 1 : strcmp(kind, "file") == 0 ? 0x40 : 0)
    | (creating || logging ? 2 : 0);
  disposition = creating ? 2 : logging ? 3 : 1;
  status = nt_create(&file->handle, access, &context->attributes, &context->ios, NULL,
    FILE_ATTRIBUTE_NORMAL, share, disposition, options, NULL, 0);
  if (file->handle != NULL && file->handle != INVALID_HANDLE_VALUE) {
    file->handle_counted = true;
    state->live_file_count++;
    InterlockedIncrement64(&counters.open_files);
  }
  if (!call_succeeded(context, file->handle, status, "NtCreateFile", &error)) goto failed;
  if (file->handle == NULL || file->handle == INVALID_HANDLE_VALUE) {
    file->handle = NULL;
    error = fail("NtCreateFile handle", "native"); goto failed;
  }
  if (!file->handle_counted) {
    file->handle_counted = true;
    state->live_file_count++;
    InterlockedIncrement64(&counters.open_files);
  }
  created_staging = creating && strcmp(kind, "file") == 0 && context->ios.Information == 2; /* FILE_CREATED. */
  if (napi_create_external(env, file, finalize_file, NULL, &result) != napi_ok) {
    error = fail("native file exposure", "native"); goto failed;
  }
  file->exposed = true;
  if (napi_type_tag_object(env, result, &file_tag) != napi_ok) {
    error = fail("native file tag", "native"); goto failed;
  }
  return result_or_error(env, context, error, result);
failed:
  if (created_staging && !state->quarantined) {
    failure cleanup = { 0 };
    /* Reuse the settled create context; only this retained, newly-created file may be removed. */
    context->data[0] = 1;
    context->ios.Status = PS_PENDING;
    context->ios.Information = 0;
    if (!call_succeeded(context, file->handle, nt_set(file->handle, &context->ios,
      context->data, 1, 13), "NtSetInformationFile exposure rollback", &cleanup)) {
      error.cleanup_failed = true;
      error.pending = cleanup.pending;
    }
  }
  if (file->handle == INVALID_HANDLE_VALUE && !state->quarantined) file->handle = NULL;
  (void)retire_file(file, &error);
  if (!file->exposed && !state->quarantined) unlink_file(file);
  return result_or_error(env, context, error, NULL);
}

static napi_value owner_close(napi_env env, napi_callback_info info) {
  napi_value values[1];
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, true, &error);
  owned_file *file;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, true, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!retire_file(file, &error)) {
    if (error.operation == NULL) { error.operation = "native close unconfirmed"; error.code = "unavailable"; }
    return throw_failure(env, error);
  }
  return NULL;
}

static bool query_width(uint32_t cls, uint32_t bytes, bool volume, size_t *minimum) {
  if (volume) {
    *minimum = cls == 4 ? 8 : cls == 7 ? 32 : 0;
    return *minimum != 0 && bytes == *minimum;
  }
  *minimum = cls == 4 ? 40 : cls == 5 ? 24 : cls == 16 ? 4 : cls == 48 ? 4 : cls == 51 ? 1 : cls == 71 ? 4 : 0;
  return *minimum != 0 && (cls == 48 ? bytes >= 4 && bytes <= 65540 : bytes == *minimum);
}

static napi_value owner_query(napi_env env, napi_callback_info info) {
  napi_value values[4], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 4, values, false, &error);
  owned_file *file;
  io_context *context;
  uint32_t cls, bytes;
  size_t minimum;
  bool volume;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!uint_argument(env, values[1], 71, &cls) || !uint_argument(env, values[2], 65540, &bytes)
    || napi_get_value_bool(env, values[3], &volume) != napi_ok || !query_width(cls, bytes, volume, &minimum))
    return throw_failure(env, fail("native query class or width", "unsupported"));
  context = new_context(state, bytes, &error);
  if (context == NULL) return throw_failure(env, error);
  if (!call_succeeded(context, file->handle, (volume ? nt_volume : nt_query)(file->handle,
    &context->ios, context->data, bytes, cls), "native query", &error)) goto done;
  if (context->ios.Information > bytes || context->ios.Information < minimum) {
    error = fail("native query result bounds", "native"); goto done;
  }
  if (napi_create_buffer_copy(env, context->ios.Information, context->data, NULL, &result) != napi_ok)
    error = fail("native query result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_file_type(napi_env env, napi_callback_info info) {
  napi_value values[1], result;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  DWORD type, code;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  SetLastError(ERROR_SUCCESS);
  type = GetFileType(file->handle);
  code = GetLastError();
  if (type == FILE_TYPE_UNKNOWN && code != ERROR_SUCCESS) return throw_failure(env, win_failure("GetFileType", code));
  if (napi_create_uint32(env, type, &result) != napi_ok) return throw_failure(env, fail("file type result", "native"));
  return result;
}

static napi_value owner_reparse(napi_env env, napi_callback_info info) {
  napi_value values[1], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  io_context *context;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  context = new_context(state, 16384, &error);
  if (context == NULL) return throw_failure(env, error);
  /* FSCTL_GET_REPARSE_POINT: no target resolution, and all kernel output storage belongs to this owner. */
  if (!DeviceIoControl(file->handle, 0x000900a8, NULL, 0, context->data, 16384, &context->count, NULL)) {
    DWORD code = GetLastError();
    error = win_failure("FSCTL_GET_REPARSE_POINT", code);
    if (code == ERROR_IO_PENDING) {
      context->pending = true;
      InterlockedIncrement64(&counters.pending_contexts);
      quarantine(state, true);
      error.code = "unavailable"; error.pending = true; error.cleanup_failed = true;
    }
  } else if (context->count < 8 || context->count > 16384) error = fail("reparse result bounds", "native");
  else if (napi_create_buffer_copy(env, context->count, context->data, NULL, &result) != napi_ok)
    error = fail("reparse result exposure", "native");
  return result_or_error(env, context, error, result);
}

static napi_value owner_file_id(napi_env env, napi_callback_info info) {
  napi_value values[1], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  io_context *context;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  context = new_context(state, sizeof(FILE_ID_INFO), &error);
  if (context == NULL) return throw_failure(env, error);
  if (!GetFileInformationByHandleEx(file->handle, FileIdInfo, context->data, (DWORD)sizeof(FILE_ID_INFO)))
    error = win_failure("FILE_ID_INFO", GetLastError());
  else if (napi_create_buffer_copy(env, sizeof(FILE_ID_INFO), context->data, NULL, &result) != napi_ok)
    error = fail("file identity result", "native");
  return result_or_error(env, context, error, result);
}

static napi_value owner_volume_info(napi_env env, napi_callback_info info) {
  napi_value values[1], result = NULL, value;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  io_context *context;
  size_t length = 0;
  WCHAR *filesystem;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  context = new_context(state, 32 * sizeof(WCHAR), &error);
  if (context == NULL) return throw_failure(env, error);
  filesystem = (WCHAR *)context->data;
  if (!GetVolumeInformationByHandleW(file->handle, NULL, 0, &context->count,
    &context->needed, (LPDWORD)&context->offset.LowPart, filesystem, 32)) {
    error = win_failure("GetVolumeInformationByHandleW", GetLastError()); goto done;
  }
  while (length < 32 && filesystem[length] != 0) length++;
  if (length == 32) { error = fail("filesystem name bounds", "native"); goto done; }
  if (napi_create_object(env, &result) != napi_ok
    || napi_create_string_utf16(env, (const char16_t *)filesystem, length, &value) != napi_ok
    || napi_set_named_property(env, result, "filesystem", value) != napi_ok
    || napi_create_uint32(env, context->offset.LowPart, &value) != napi_ok
    || napi_set_named_property(env, result, "flags", value) != napi_ok) error = fail("volume result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_security(napi_env env, napi_callback_info info) {
  napi_value values[1], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  io_context *context;
  DWORD code, length;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  context = new_context(state, DESCRIPTOR_LIMIT, &error);
  if (context == NULL) return throw_failure(env, error);
  code = GetSecurityInfo(file->handle, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    NULL, NULL, NULL, NULL, &context->descriptor);
  if (context->descriptor != NULL) InterlockedIncrement64(&counters.local_blocks);
  if (code != ERROR_SUCCESS) { error = win_failure("GetSecurityInfo", code); goto done; }
  if (context->descriptor == NULL) { error = fail("security descriptor missing", "privacy"); goto done; }
  length = GetSecurityDescriptorLength(context->descriptor);
  if (length < 20 || length > context->capacity) { error = fail("security descriptor bounds", "privacy"); goto done; }
  memcpy(context->data, context->descriptor, length);
  if (!release_descriptor(context, &error)) goto done;
  if (napi_create_buffer_copy(env, length, context->data, NULL, &result) != napi_ok)
    error = fail("security descriptor result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_read(napi_env env, napi_callback_info info) {
  napi_value values[2], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 2, values, false, &error);
  owned_file *file;
  io_context *context;
  uint32_t maximum;
  NTSTATUS status;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!uint_argument(env, values[1], READ_LIMIT, &maximum)) return throw_failure(env, fail("read bound", "limit"));
  context = new_context(state, maximum, &error);
  if (context == NULL) return throw_failure(env, error);
  if (maximum == 0) context->ios.Information = 0;
  else {
    if (!complete_io(context, file->handle, nt_read(file->handle, NULL, NULL, NULL, &context->ios,
      context->data, maximum, NULL, NULL), "NtReadFile", &error, &status)) goto done;
    if (status == PS_END_OF_FILE) context->ios.Information = 0;
    else if (status != PS_SUCCESS) { error = nt_failure("NtReadFile", status); goto done; }
  }
  if (context->ios.Information > maximum) { error = fail("read result bounds", "native"); goto done; }
  if (napi_create_buffer_copy(env, context->ios.Information, context->data, NULL, &result) != napi_ok)
    error = fail("read result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_write(napi_env env, napi_callback_info info) {
  napi_value values[3], result = NULL;
  failure error = { 0 };
  owner *state = arguments(env, info, 3, values, false, &error);
  owned_file *file;
  io_context *context;
  void *bytes;
  size_t length;
  bool append;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!bytes_argument(env, values[1], &bytes, &length) || length == 0 || length > WRITE_LIMIT
    || napi_get_value_bool(env, values[2], &append) != napi_ok) return throw_failure(env, fail("write bounds", "limit"));
  context = new_context(state, length, &error);
  if (context == NULL) return throw_failure(env, error);
  memcpy(context->data, bytes, length);
  context->offset.QuadPart = -1; /* FILE_WRITE_TO_END_OF_FILE, never a caller offset. */
  if (!call_succeeded(context, file->handle, nt_write(file->handle, NULL, NULL, NULL,
    &context->ios, context->data, (ULONG)length, append ? &context->offset : NULL, NULL),
    append ? "NtWriteFile append" : "NtWriteFile", &error)) goto done;
  if (context->ios.Information == 0 || context->ios.Information > length) {
    error = fail("write result bounds", "native"); goto done;
  }
  if (napi_create_uint32(env, (uint32_t)context->ios.Information, &result) != napi_ok)
    error = fail("write result", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_flush(napi_env env, napi_callback_info info) {
  napi_value values[1];
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!FlushFileBuffers(file->handle)) return throw_failure(env, win_failure("FlushFileBuffers", GetLastError()));
  return NULL;
}

static napi_value owner_rename(napi_env env, napi_callback_info info) {
  napi_value values[4];
  failure error = { 0 };
  owner *state = arguments(env, info, 4, values, false, &error);
  owned_file *file, *parent;
  io_context *context;
  WCHAR name[NAME_LIMIT + 1];
  size_t length;
  bool replace;
  DWORD flags, name_bytes;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  parent = file_argument(env, values[1], state, false, &error);
  if (parent == NULL) return throw_failure(env, error);
  if (!name_argument(env, values[2], name, false, &length)
    || napi_get_value_bool(env, values[3], &replace) != napi_ok) return throw_failure(env, fail("rename arguments", "identity"));
  context = new_context(state, 24 + length * sizeof(WCHAR), &error);
  if (context == NULL) return throw_failure(env, error);
  flags = replace ? 3 : 0; /* FileRenameInformationEx: REPLACE_IF_EXISTS | POSIX_SEMANTICS. */
  name_bytes = (DWORD)(length * sizeof(WCHAR));
  memcpy(context->data, &flags, sizeof(flags));
  memcpy(context->data + 8, &parent->handle, sizeof(parent->handle));
  memcpy(context->data + 16, &name_bytes, sizeof(name_bytes));
  memcpy(context->data + 20, name, name_bytes);
  (void)call_succeeded(context, file->handle, nt_set(file->handle, &context->ios,
    context->data, (ULONG)context->capacity, 65), "NtSetInformationFile rename", &error);
  return result_or_error(env, context, error, NULL);
}

static napi_value owner_remove(napi_env env, napi_callback_info info) {
  napi_value values[1];
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  io_context *context;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  context = new_context(state, 1, &error);
  if (context == NULL) return throw_failure(env, error);
  context->data[0] = 1;
  (void)call_succeeded(context, file->handle, nt_set(file->handle, &context->ios,
    context->data, 1, 13), "NtSetInformationFile disposition", &error);
  return result_or_error(env, context, error, NULL);
}

static bool settle_lock(owned_file *file, const char *operation, failure *error) {
  DWORD count = 0, code, wait;
  unsigned int attempt;
  InterlockedIncrement64(&counters.pending_contexts);
  for (attempt = 0; attempt < 2; attempt++) {
    wait = WaitForSingleObject(file->handle, SETTLE_MILLISECONDS);
    if (wait == WAIT_OBJECT_0) {
      if (GetOverlappedResult(file->handle, &file->lease, &count, FALSE)) {
        InterlockedDecrement64(&counters.pending_contexts);
        return true;
      }
      code = GetLastError();
      if (code != ERROR_IO_INCOMPLETE) {
        InterlockedDecrement64(&counters.pending_contexts);
        *error = win_failure(operation, code);
        return false;
      }
    }
    if (attempt == 0) (void)CancelIoEx(file->handle, &file->lease);
  }
  *error = win_failure(operation, ERROR_IO_PENDING);
  error->code = "unavailable";
  error->pending = true;
  error->cleanup_failed = true;
  quarantine(file->owner, true);
  return false;
}

static napi_value owner_lock(napi_env env, napi_callback_info info) {
  napi_value values[1];
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  DWORD code;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (file->locked) return throw_failure(env, fail("lease already held", "busy"));
  memset(&file->lease, 0, sizeof(file->lease));
  if (!LockFileEx(file->handle, LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &file->lease)) {
    code = GetLastError();
    if (code != ERROR_IO_PENDING) return throw_failure(env, win_failure("LockFileEx", code));
    if (!settle_lock(file, "LockFileEx completion", &error)) return throw_failure(env, error);
  }
  file->locked = true;
  return NULL;
}

static napi_value owner_unlock(napi_env env, napi_callback_info info) {
  napi_value values[1];
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  owned_file *file;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!file->locked) return NULL;
  /* Synchronous handles normally settle before return; retain even an unexpected pending result. */
  if (!UnlockFileEx(file->handle, 0, 1, 0, &file->lease)) {
    DWORD code = GetLastError();
    if (code != ERROR_IO_PENDING) return throw_failure(env, win_failure("UnlockFileEx", code));
    if (!settle_lock(file, "UnlockFileEx completion", &error)) return throw_failure(env, error);
  }
  file->locked = false;
  return NULL;
}

static napi_value owner_names(napi_env env, napi_callback_info info) {
  napi_value values[2], result = NULL, name;
  failure error = { 0 };
  owner *state = arguments(env, info, 2, values, false, &error);
  owned_file *file;
  io_context *context;
  uint32_t maximum, records = 0, names = 0;
  BOOLEAN restart = TRUE;
  NTSTATUS status;
  if (state == NULL) return throw_failure(env, error);
  file = file_argument(env, values[0], state, false, &error);
  if (file == NULL) return throw_failure(env, error);
  if (!uint_argument(env, values[1], ENUM_LIMIT, &maximum)) return throw_failure(env, fail("directory inventory bound", "limit"));
  context = new_context(state, 65536, &error);
  if (context == NULL) return throw_failure(env, error);
  if (napi_create_array(env, &result) != napi_ok) { error = fail("directory result", "native"); goto done; }
  for (;;) {
    size_t length, offset = 0;
    context->ios.Status = PS_PENDING;
    context->ios.Information = 0;
    if (!complete_io(context, file->handle, nt_directory(file->handle, NULL, NULL, NULL,
      &context->ios, context->data, (ULONG)context->capacity, 12, FALSE, NULL, restart),
      "NtQueryDirectoryFile", &error, &status)) goto done;
    if (status == PS_NO_MORE_FILES) break;
    if (status != PS_SUCCESS) { error = nt_failure("NtQueryDirectoryFile", status); goto done; }
    restart = FALSE;
    length = context->ios.Information;
    if (length < 12 || length > context->capacity) { error = fail("directory result bounds", "native"); goto done; }
    for (;;) {
      DWORD next, bytes;
      const WCHAR *text;
      bool dot;
      if (offset > length || length - offset < 12) { error = fail("directory record bounds", "native"); goto done; }
      memcpy(&next, context->data + offset, sizeof(next));
      memcpy(&bytes, context->data + offset + 8, sizeof(bytes));
      if (bytes == 0 || (bytes & 1) || bytes > length - offset - 12
        || (next != 0 && (next < 12u + bytes || (next & 3) || next > length - offset - 12))) {
        error = fail("directory name bounds", "native"); goto done;
      }
      if (++records > maximum + 2) { error = fail("directory scanned record count", "limit"); goto done; }
      text = (const WCHAR *)(context->data + offset + 12);
      dot = bytes == 2 && text[0] == L'.';
      dot = dot || (bytes == 4 && text[0] == L'.' && text[1] == L'.');
      if (!dot) {
        if (names >= maximum) { error = fail("directory entry count", "limit"); goto done; }
        if (napi_create_string_utf16(env, (const char16_t *)text, bytes / 2, &name) != napi_ok
          || napi_set_element(env, result, names++, name) != napi_ok) {
          error = fail("directory entry result", "native"); goto done;
        }
      }
      if (next == 0) break;
      offset += next;
    }
  }
done:
  return result_or_error(env, context, error, result);
}

/* One bounded read-only process observation; a failed open/query never means confirmed exit. */
static napi_value owner_observe_process(napi_env env, napi_callback_info info) {
  napi_value values[1], result = NULL, value;
  failure error = { 0 };
  owner *state = arguments(env, info, 1, values, false, &error);
  io_context *context;
  uint32_t pid;
  FILETIME creation, exit_time, kernel, user;
  uint64_t creation_time;
  DWORD waited;
  char encoded[21];
  if (state == NULL) return throw_failure(env, error);
  if (!uint_argument(env, values[0], UINT32_MAX, &pid) || pid == 0)
    return throw_failure(env, fail("process observation PID", "identity"));
  context = new_context(state, 0, &error);
  if (context == NULL) return throw_failure(env, error);
  context->process = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE, FALSE, pid);
  if (context->process == NULL) { error = win_failure("OpenProcess observation unresolved", GetLastError()); goto done; }
  InterlockedIncrement64(&counters.open_processes);
  if (GetProcessId(context->process) != pid) { error = fail("process observation identity", "identity"); goto done; }
  if (!GetProcessTimes(context->process, &creation, &exit_time, &kernel, &user)) {
    error = win_failure("GetProcessTimes observation unresolved", GetLastError()); goto done;
  }
  creation_time = ((uint64_t)creation.dwHighDateTime << 32) | creation.dwLowDateTime;
  if (creation_time == 0) { error = fail("process creation time unavailable", "identity"); goto done; }
  waited = WaitForSingleObject(context->process, 0);
  if (waited != WAIT_OBJECT_0 && waited != WAIT_TIMEOUT) {
    error = waited == WAIT_FAILED ? win_failure("process exit observation unresolved", GetLastError())
      : fail("unexpected process wait result", "native");
    goto done;
  }
  if (!release_process(context, &error)) goto done;
  if (snprintf(encoded, sizeof(encoded), "%llu", (unsigned long long)creation_time) <= 0) {
    error = fail("process creation time encoding", "native"); goto done;
  }
  if (napi_create_object(env, &result) != napi_ok) { error = fail("process observation result", "native"); goto done; }
#define PROCESS_STRING(name, text) do { \
  if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) != napi_ok \
    || napi_set_named_property(env, result, name, value) != napi_ok) { \
    error = fail("process observation field", "native"); goto done; } \
} while (0)
  PROCESS_STRING("platform", "win32");
  PROCESS_STRING("creationTime100ns", encoded);
  PROCESS_STRING("state", waited == WAIT_OBJECT_0 ? "exited" : "running");
  PROCESS_STRING("mechanism", "GetProcessTimes+WaitForSingleObject");
#undef PROCESS_STRING
  if (napi_create_uint32(env, pid, &value) != napi_ok || napi_set_named_property(env, result, "pid", value) != napi_ok
    || napi_get_boolean(env, true, &value) != napi_ok || napi_set_named_property(env, result, "observationOnly", value) != napi_ok)
    error = fail("process observation field", "native");
done:
  return result_or_error(env, context, error, result);
}

static napi_value owner_statistics(napi_env env, napi_callback_info info) {
  failure error = { 0 };
  owner *state = arguments(env, info, 0, NULL, true, &error);
  napi_value result, value;
  if (state == NULL) return throw_failure(env, error);
  if (napi_create_object(env, &result) != napi_ok) return throw_failure(env, fail("statistics result", "native"));
#define STAT(name, field) do { \
  if (napi_create_double(env, (double)InterlockedCompareExchange64(&counters.field, 0, 0), &value) != napi_ok \
    || napi_set_named_property(env, result, name, value) != napi_ok) \
    return throw_failure(env, fail("statistics field", "native")); \
} while (0)
  /* Separate atomic reads: reconcile allocation classes only at controlled quiescent barriers. */
  STAT("owners", owners);
  STAT("fileRecords", file_records);
  STAT("openFiles", open_files);
  STAT("openTokens", open_tokens);
  STAT("openProcesses", open_processes);
  STAT("localAllocBlocks", local_blocks);
  STAT("heapBlocks", heap_blocks);
  STAT("pendingContexts", pending_contexts);
  STAT("unconfirmedReleases", unconfirmed_releases);
#undef STAT
  return result;
}

static BOOL CALLBACK initialize(PINIT_ONCE once, PVOID parameter, PVOID *context) {
  HMODULE module, pinned;
  (void)once;
  (void)parameter;
  (void)context;
  module = GetModuleHandleW(L"ntdll.dll");
  if (module == NULL) return TRUE;
#define LOAD(target, symbol) do { \
  FARPROC address = GetProcAddress(module, symbol); \
  _Static_assert(sizeof(target) == sizeof(address), "Windows function pointer width"); \
  memcpy(&target, &address, sizeof(target)); \
  if (target == NULL) return TRUE; \
} while (0)
  LOAD(nt_create, "NtCreateFile");
  LOAD(nt_query, "NtQueryInformationFile");
  LOAD(nt_volume, "NtQueryVolumeInformationFile");
  LOAD(nt_set, "NtSetInformationFile");
  LOAD(nt_read, "NtReadFile");
  LOAD(nt_write, "NtWriteFile");
  LOAD(nt_directory, "NtQueryDirectoryFile");
#undef LOAD
  /* Native quarantine and finalizer code must survive the final Worker unload. */
  if (!GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_PIN,
    (LPCWSTR)&initialization, &pinned)) return TRUE;
  initialized = true;
  return TRUE;
}

static napi_value create_owner(napi_env env, napi_callback_info info) {
  napi_value result;
  owner *state;
  napi_status status;
  size_t argc = 0;
  failure error = { 0 };
  const napi_property_descriptor methods[] = {
    { "tokenUser", NULL, owner_token_user, NULL, NULL, NULL, napi_default, NULL },
    { "open", NULL, owner_open, NULL, NULL, NULL, napi_default, NULL },
    { "close", NULL, owner_close, NULL, NULL, NULL, napi_default, NULL },
    { "query", NULL, owner_query, NULL, NULL, NULL, napi_default, NULL },
    { "reparse", NULL, owner_reparse, NULL, NULL, NULL, napi_default, NULL },
    { "fileType", NULL, owner_file_type, NULL, NULL, NULL, napi_default, NULL },
    { "fileId", NULL, owner_file_id, NULL, NULL, NULL, napi_default, NULL },
    { "volumeInfo", NULL, owner_volume_info, NULL, NULL, NULL, napi_default, NULL },
    { "security", NULL, owner_security, NULL, NULL, NULL, napi_default, NULL },
    { "read", NULL, owner_read, NULL, NULL, NULL, napi_default, NULL },
    { "write", NULL, owner_write, NULL, NULL, NULL, napi_default, NULL },
    { "flush", NULL, owner_flush, NULL, NULL, NULL, napi_default, NULL },
    { "rename", NULL, owner_rename, NULL, NULL, NULL, napi_default, NULL },
    { "remove", NULL, owner_remove, NULL, NULL, NULL, napi_default, NULL },
    { "lock", NULL, owner_lock, NULL, NULL, NULL, napi_default, NULL },
    { "unlock", NULL, owner_unlock, NULL, NULL, NULL, napi_default, NULL },
    { "names", NULL, owner_names, NULL, NULL, NULL, napi_default, NULL },
    { "statistics", NULL, owner_statistics, NULL, NULL, NULL, napi_default, NULL },
    { "observeProcess", NULL, owner_observe_process, NULL, NULL, NULL, napi_default, NULL }
  };
  if (napi_get_cb_info(env, info, &argc, NULL, NULL, NULL) != napi_ok)
    return throw_failure(env, fail("create owner arguments", "native"));
  if (!InitOnceExecuteOnce(&initialization, initialize, NULL, NULL) || !initialized)
    return throw_failure(env, fail("Windows native owner initialization", "unavailable"));
  if (InterlockedIncrement64(&counters.owners) > OWNER_LIMIT) {
    InterlockedDecrement64(&counters.owners);
    return throw_failure(env, fail("native owner limit", "limit"));
  }
  state = allocate(sizeof(*state));
  if (state == NULL) {
    InterlockedDecrement64(&counters.owners);
    return throw_failure(env, fail("native owner allocation", "unavailable"));
  }
  state->env = env;
  state->references = 1;
  status = napi_create_object(env, &result);
  if (status == napi_ok) status = napi_type_tag_object(env, result, &owner_tag);
  if (status == napi_ok) status = napi_define_properties(env, result, sizeof(methods) / sizeof(methods[0]), methods);
  if (status != napi_ok) { owner_release(state); return throw_failure(env, fail("native owner result", "native")); }
  status = napi_add_env_cleanup_hook(env, cleanup_owner, state);
  if (status != napi_ok) { owner_release(state); return throw_failure(env, fail("native owner cleanup hook", "native")); }
  state->references++;
  status = napi_wrap(env, result, state, finalize_owner, NULL, NULL);
  if (status != napi_ok) {
    error = fail("native owner exposure", "native");
    if (napi_remove_env_cleanup_hook(env, cleanup_owner, state) == napi_ok) owner_release(state);
    else { quarantine(state, false); error.cleanup_failed = true; }
    owner_release(state);
    return throw_failure(env, error);
  }
  return result;
}

NAPI_MODULE_INIT() {
  napi_value factory;
  if (napi_create_function(env, "createOwner", NAPI_AUTO_LENGTH, create_owner, NULL, &factory) != napi_ok
    || napi_set_named_property(env, exports, "createOwner", factory) != napi_ok)
    return throw_failure(env, fail("Windows native owner export", "native"));
  return exports;
}
