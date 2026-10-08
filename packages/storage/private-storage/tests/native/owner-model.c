/* Synthetic syscall/Node-API responses exercise the actual C owner, never a Windows oracle. */
#include <assert.h>
#include <stdio.h>
#include <string.h>
#include "../../../../../native/system/packages/entry/src/windows-private-owner.c"

static unsigned close_calls, cancel_calls, wait_calls, local_free_calls;
static bool close_ok = true, local_free_ok = true;
static DWORD last_error = ERROR_ACCESS_DENIED;
static io_context *waiting_context;
static unsigned complete_wait;
static NTSTATUS completed_status;
static NTSTATUS create_status;
static HANDLE created_handle;
static bool exposure_ok, tag_ok = true;
static uintptr_t create_information = 2;
static NTSTATUS disposition_status;
static unsigned disposition_calls;
static bool reported_cleanup_failed, reported_pending;
static char reported_operation[96];
static bool exposure_registered;
static owner *current_owner;
static owned_file *exposed_file;
static unsigned throws;
static const char *last_operation;
static bool last_cleanup_failed;
static bool thread_token, restricted_token, partial_process_token;
static bool invalid_sid_pointer, invalid_sid_length;
static unsigned sid_validation_calls, copied_sid_bytes;
static bool modeled_child;
static const char *modeled_kind = "directory", *modeled_mode = "inspect";
static owned_file *modeled_parent;
static SECURITY_DESCRIPTOR_RELATIVE modeled_descriptor;
static ACCESS_MASK expected_access = 0x1200a1;
static ULONG expected_share = 3, expected_disposition = 1, expected_options = 0x200021;
static bool process_case, process_open_ok = true, process_times_ok = true, process_pid_ok = true, process_zero_birth;
static uint32_t process_pid = 42, process_wait = WAIT_TIMEOUT;
static unsigned process_opens;
static char observed_birth[32], observed_process_state[16];
static bool reparse_case, reparse_ok = true, reparse_exposure_ok = true;
static DWORD reparse_length = 20;

LONG64 InterlockedIncrement64(volatile LONG64 *value) { return ++*value; }
LONG64 InterlockedDecrement64(volatile LONG64 *value) { return --*value; }
LONG64 InterlockedCompareExchange64(volatile LONG64 *value, LONG64 exchange, LONG64 comparand) {
  LONG64 before = *value;
  if (before == comparand) *value = exchange;
  return before;
}
void AcquireSRWLockExclusive(SRWLOCK *lock) { (void)lock; }
void ReleaseSRWLockExclusive(SRWLOCK *lock) { (void)lock; }
BOOL CloseHandle(HANDLE handle) { assert(handle != NULL); close_calls++; return close_ok; }
DWORD GetLastError(void) { return last_error; }
void SetLastError(DWORD value) { last_error = value; }
PVOID LocalFree(PVOID pointer) { local_free_calls++; return local_free_ok ? NULL : pointer; }
DWORD WaitForSingleObject(HANDLE handle, DWORD milliseconds) {
  assert(handle != NULL);
  if (process_case && milliseconds == 0) return process_wait;
  assert(milliseconds == SETTLE_MILLISECONDS);
  wait_calls++;
  if (complete_wait == wait_calls) {
    assert(waiting_context != NULL);
    waiting_context->ios.Status = completed_status;
    return WAIT_OBJECT_0;
  }
  return WAIT_TIMEOUT;
}
BOOL CancelIoEx(HANDLE handle, OVERLAPPED *overlapped) {
  assert(handle != NULL); (void)overlapped; cancel_calls++; return TRUE;
}
BOOL DeviceIoControl(HANDLE handle, DWORD control, PVOID input, DWORD input_size,
    PVOID output, DWORD capacity, DWORD *count, OVERLAPPED *overlapped) {
  assert(handle != NULL && control == 0x000900a8 && input == NULL && input_size == 0 && overlapped == NULL);
  assert(current_owner->contexts != NULL && output == current_owner->contexts->data
    && count == &current_owner->contexts->count && capacity == 16384);
  *count = reparse_length;
  return reparse_ok;
}
HANDLE GetCurrentThread(void) { return (HANDLE)(uintptr_t)200; }
HANDLE GetCurrentProcess(void) { return (HANDLE)(uintptr_t)201; }
BOOL OpenThreadToken(HANDLE thread, DWORD access, BOOL self, PHANDLE output) {
  (void)thread; assert(access == TOKEN_QUERY && self);
  *output = thread_token ? (HANDLE)(uintptr_t)202 : NULL;
  last_error = thread_token ? ERROR_SUCCESS : ERROR_NO_TOKEN;
  return thread_token;
}
BOOL OpenProcessToken(HANDLE process, DWORD access, PHANDLE output) {
  (void)process; assert(access == TOKEN_QUERY);
  *output = (HANDLE)(uintptr_t)203;
  last_error = partial_process_token ? ERROR_ACCESS_DENIED : ERROR_SUCCESS;
  return !partial_process_token;
}
HANDLE OpenProcess(DWORD access, BOOL inherit, DWORD pid) {
  assert(access == (PROCESS_QUERY_LIMITED_INFORMATION | SYNCHRONIZE) && !inherit && pid == process_pid);
  process_opens++; return process_open_ok ? (HANDLE)(uintptr_t)300 : NULL;
}
DWORD GetProcessId(HANDLE process) { assert(process == (HANDLE)(uintptr_t)300); return process_pid_ok ? process_pid : process_pid + 1; }
BOOL GetProcessTimes(HANDLE process, FILETIME *creation, FILETIME *exit_time, FILETIME *kernel, FILETIME *user) {
  assert(process == (HANDLE)(uintptr_t)300);
  memset(exit_time, 0, sizeof(*exit_time)); memset(kernel, 0, sizeof(*kernel)); memset(user, 0, sizeof(*user));
  creation->dwHighDateTime = process_zero_birth ? 0 : 0xffffffffu;
  creation->dwLowDateTime = process_zero_birth ? 0 : 0xfffffff8u;
  return process_times_ok;
}
BOOL IsTokenRestricted(HANDLE token) { assert(token != NULL); return restricted_token; }
BOOL GetTokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS cls, PVOID output, DWORD length, LPDWORD needed) {
  unsigned char *bytes = output;
  assert(token != NULL && cls == TokenUser);
  *needed = 28;
  if (output == NULL) { assert(length == 0); last_error = ERROR_INSUFFICIENT_BUFFER; return FALSE; }
  assert(length == 28);
  ((TOKEN_USER *)output)->User.Sid = invalid_sid_pointer ? (PSID)UINTPTR_MAX : bytes + 16;
  bytes[16] = 1; bytes[17] = invalid_sid_length ? 255 : 1;
  bytes[23] = 5; bytes[24] = 21;
  return TRUE;
}
BOOL IsValidSid(PSID sid) { assert(sid != NULL); sid_validation_calls++; return TRUE; }
BOOL IsValidSecurityDescriptor(PSECURITY_DESCRIPTOR descriptor) { (void)descriptor; return TRUE; }

/* Only owner_open is entered through modeled JavaScript arguments. All output values are inert. */
#define JS_RECEIVER ((napi_value)(uintptr_t)1)
#define JS_NULL ((napi_value)(uintptr_t)2)
#define JS_ROOT ((napi_value)(uintptr_t)3)
#define JS_KIND ((napi_value)(uintptr_t)4)
#define JS_MODE ((napi_value)(uintptr_t)5)
#define JS_RESULT ((napi_value)(uintptr_t)6)
#define JS_VALUE ((napi_value)(uintptr_t)7)
#define JS_PARENT ((napi_value)(uintptr_t)8)
#define JS_DESCRIPTOR ((napi_value)(uintptr_t)9)
static napi_status create_stub_value(napi_value *result) { *result = JS_VALUE; return napi_ok; }
napi_status napi_get_cb_info(napi_env env, napi_callback_info info, size_t *argc,
                            napi_value *argv, napi_value *receiver, void **data) {
  (void)env; (void)info; (void)data;
  *receiver = JS_RECEIVER;
  if (*argc == 0) return napi_ok;
  if (process_case) { assert(*argc == 1); argv[0] = JS_VALUE; return napi_ok; }
  if (reparse_case) { assert(*argc == 1); argv[0] = JS_PARENT; return napi_ok; }
  assert(*argc == 5);
  argv[0] = modeled_child ? JS_PARENT : JS_NULL; argv[1] = JS_ROOT; argv[2] = JS_KIND; argv[3] = JS_MODE;
  argv[4] = strcmp(modeled_mode, "create") == 0 || strcmp(modeled_mode, "log") == 0 ? JS_DESCRIPTOR : JS_NULL;
  *receiver = JS_RECEIVER;
  return napi_ok;
}
napi_status napi_check_object_type_tag(napi_env env, napi_value value, const napi_type_tag *tag, bool *result) {
  (void)env; *result = (value == JS_RECEIVER && tag == &owner_tag) || (value == JS_PARENT && tag == &file_tag); return napi_ok;
}
napi_status napi_unwrap(napi_env env, napi_value value, void **result) {
  (void)env; assert(value == JS_RECEIVER); *result = current_owner; return napi_ok;
}
napi_status napi_typeof(napi_env env, napi_value value, napi_valuetype *result) {
  (void)env; *result = value == JS_NULL ? napi_null : napi_string; return napi_ok;
}
napi_status napi_get_value_external(napi_env env, napi_value value, void **result) {
  (void)env; if (value != JS_PARENT) return napi_invalid_arg; *result = modeled_parent; return napi_ok;
}
napi_status napi_get_value_string_utf8(napi_env env, napi_value value, char *buffer, size_t size, size_t *result) {
  const char *text = value == JS_KIND ? modeled_kind : modeled_mode;
  (void)env; *result = strlen(text);
  if (buffer != NULL) { assert(size > *result); memcpy(buffer, text, *result + 1); }
  return napi_ok;
}
napi_status napi_get_value_string_utf16(napi_env env, napi_value value, char16_t *buffer, size_t size, size_t *result) {
  const char16_t root_name[] = { '\\', '?', '?', '\\', 'C', ':', '\\', 0 };
  const char16_t child_name[] = { 'r', 'e', 'c', 'o', 'r', 'd', 0 };
  const char16_t *text = modeled_child ? child_name : root_name;
  (void)env; assert(value == JS_ROOT); *result = modeled_child ? 6 : 7;
  if (buffer != NULL) { assert(size > *result); memcpy(buffer, text, (*result + 1) * sizeof(char16_t)); }
  return napi_ok;
}
napi_status napi_is_typedarray(napi_env env, napi_value value, bool *result) {
  (void)env; *result = value == JS_DESCRIPTOR; return napi_ok;
}
napi_status napi_get_typedarray_info(napi_env env, napi_value value, napi_typedarray_type *type,
                                    size_t *length, void **data, napi_value *buffer, size_t *offset) {
  (void)env; (void)buffer; (void)offset;
  if (value != JS_DESCRIPTOR) return napi_invalid_arg;
  *type = napi_uint8_array; *length = sizeof(modeled_descriptor); *data = &modeled_descriptor; return napi_ok;
}
napi_status napi_create_external(napi_env env, void *data, napi_finalize finalize, void *hint, napi_value *result) {
  owned_file *file = data;
  (void)env; (void)finalize; (void)hint;
  exposure_registered = current_owner->files == file && file->handle == created_handle
    && counters.open_files == (LONG64)current_owner->live_file_count
    && current_owner->live_file_count > 0 && current_owner->file_count >= current_owner->live_file_count;
  assert(exposure_registered);
  if (!exposure_ok) return napi_generic_failure;
  exposed_file = file;
  *result = JS_RESULT;
  return napi_ok;
}
napi_status napi_type_tag_object(napi_env env, napi_value value, const napi_type_tag *tag) {
  (void)env; assert(value == JS_RESULT); assert(tag == &file_tag); return tag_ok ? napi_ok : napi_generic_failure;
}
napi_status napi_is_exception_pending(napi_env env, bool *result) { (void)env; *result = false; return napi_ok; }
napi_status napi_get_and_clear_last_exception(napi_env env, napi_value *result) { (void)env; return create_stub_value(result); }
napi_status napi_create_string_utf8(napi_env env, const char *value, size_t length, napi_value *result) {
  (void)env; (void)length; last_operation = value; return create_stub_value(result);
}
napi_status napi_create_error(napi_env env, napi_value code, napi_value message, napi_value *result) {
  (void)env; (void)code; (void)message; return create_stub_value(result);
}
napi_status napi_create_buffer_copy(napi_env env, size_t length, const void *data, void **copy, napi_value *result) {
  (void)env; (void)copy;
  if (reparse_case) { assert(data == current_owner->contexts->data && length == reparse_length);
    return reparse_exposure_ok ? create_stub_value(result) : napi_generic_failure; }
  assert(data != NULL && length == 12);
  assert(close_calls == 1 && counters.open_tokens == 0);
  copied_sid_bytes = (unsigned)length;
  return create_stub_value(result);
}
napi_status napi_get_value_double(napi_env env, napi_value value, double *result) {
  (void)env; assert(value == JS_VALUE); *result = process_pid; return napi_ok;
}
napi_status napi_create_object(napi_env env, napi_value *result) { (void)env; *result = JS_RESULT; return napi_ok; }
napi_status napi_create_uint32(napi_env env, uint32_t value, napi_value *result) {
  (void)env; (void)value; return create_stub_value(result);
}
napi_status napi_get_boolean(napi_env env, bool value, napi_value *result) {
  (void)env; last_cleanup_failed = value; return create_stub_value(result);
}
napi_status napi_set_named_property(napi_env env, napi_value object, const char *name, napi_value value) {
  (void)env; (void)object; (void)value;
  if (strcmp(name, "operation") == 0) snprintf(reported_operation, sizeof(reported_operation), "%s", last_operation);
  if (strcmp(name, "cleanupFailed") == 0) reported_cleanup_failed = last_cleanup_failed;
  if (strcmp(name, "pending") == 0) reported_pending = last_cleanup_failed;
  if (process_case && strcmp(name, "creationTime100ns") == 0) snprintf(observed_birth, sizeof(observed_birth), "%s", last_operation);
  if (process_case && strcmp(name, "state") == 0) snprintf(observed_process_state, sizeof(observed_process_state), "%s", last_operation);
  return napi_ok;
}
napi_status napi_throw(napi_env env, napi_value error) { (void)env; (void)error; throws++; return napi_ok; }
napi_status napi_remove_env_cleanup_hook(napi_env env, napi_cleanup_hook hook, void *argument) {
  (void)env; (void)hook; (void)argument; return napi_ok;
}

static NTSTATUS modeled_create(PHANDLE handle, ACCESS_MASK access, POBJECT_ATTRIBUTES attributes,
  PIO_STATUS_BLOCK ios, PLARGE_INTEGER size, ULONG file_attributes, ULONG share, ULONG disposition,
  ULONG options, PVOID ea, ULONG ea_length) {
  (void)size; (void)file_attributes; (void)ea; (void)ea_length;
  assert(current_owner->files != NULL);
  assert(handle == &current_owner->files->handle);
  assert(current_owner->contexts != NULL);
  assert(ios == &current_owner->contexts->ios);
  assert(attributes == &current_owner->contexts->attributes);
  assert(attributes->Attributes == (strcmp(modeled_mode, "read-link") == 0 ? 0x40u : 0x1040u));
  assert(attributes->RootDirectory == (modeled_parent == NULL ? NULL : modeled_parent->handle));
  assert(access == expected_access);
  assert(share == expected_share && disposition == expected_disposition && options == expected_options);
  assert((attributes->Attributes & 2) == 0); /* OBJ_INHERIT is never requested. */
  assert((options & 0x200000) != 0); /* FILE_OPEN_REPARSE_POINT remains requested. */
  created_handle = (HANDLE)((uintptr_t)created_handle + 4);
  *handle = created_handle;
  if (create_status != PS_PENDING) ios->Status = create_status;
  ios->Information = create_information;
  waiting_context = current_owner->contexts;
  return create_status;
}

static NTSTATUS modeled_disposition(HANDLE handle, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, ULONG cls) {
  assert(strcmp(modeled_mode, "create") == 0 && strcmp(modeled_kind, "file") == 0);
  assert(handle == created_handle && handle == current_owner->files->handle && close_calls == 0);
  assert(ios == &current_owner->contexts->ios && data == current_owner->contexts->data);
  assert(ios->Status == PS_PENDING && ios->Information == 0);
  assert(length == 1 && cls == 13 && ((unsigned char *)data)[0] == 1);
  assert(create_status == PS_SUCCESS && create_information == 2);
  disposition_calls++;
  if (disposition_status != PS_PENDING) ios->Status = disposition_status;
  return disposition_status;
}

static owner *make_owner(void) {
  owner *state = allocate(sizeof(*state));
  assert(state != NULL);
  counters.owners++;
  state->env = (napi_env)(uintptr_t)1;
  state->references = 2; /* Native JS wrapper and registered environment hook. */
  return state;
}

static owned_file *make_file(owner *state) {
  owned_file *file = allocate(sizeof(*file));
  assert(file != NULL);
  counters.file_records++;
  file->owner = state;
  file->handle = (HANDLE)(uintptr_t)100;
  file->handle_counted = true;
  file->next = state->files;
  state->files = file;
  state->references++;
  state->file_count++;
  state->live_file_count++;
  counters.open_files++;
  return file;
}

static void assert_empty(void) {
  assert(counters.open_files == 0 && counters.open_tokens == 0 && counters.open_processes == 0 && counters.local_blocks == 0);
  assert(counters.heap_blocks == 0 && counters.pending_contexts == 0 && counters.unconfirmed_releases == 0);
  assert(counters.owners == 0 && counters.file_records == 0);
}

int main(int argc, char **argv) {
  owner *state;
  owned_file *file;
  io_context *context;
  failure error = { 0 };
  NTSTATUS result;
  assert(argc == 2);
  state = make_owner();
  current_owner = state;
  if (strncmp(argv[1], "reparse-", 8) == 0) {
    reparse_case = true; modeled_parent = make_file(state);
    reparse_ok = strcmp(argv[1], "reparse-refusal") != 0 && strcmp(argv[1], "reparse-pending") != 0;
    reparse_exposure_ok = strcmp(argv[1], "reparse-exposure") != 0;
    if (strcmp(argv[1], "reparse-truncated") == 0) reparse_length = 7;
    if (strcmp(argv[1], "reparse-overlong") == 0) reparse_length = 16385;
    if (strcmp(argv[1], "reparse-pending") == 0) last_error = ERROR_IO_PENDING;
    napi_value output = owner_reparse(state->env, NULL);
    assert((output == JS_VALUE) == (strcmp(argv[1], "reparse-copied") == 0));
    if (strcmp(argv[1], "reparse-pending") == 0) {
      assert(state->quarantined && state->pending && counters.pending_contexts == 1 && counters.heap_blocks == 3);
      cleanup_owner(state); assert(close_calls == 0);
    } else {
      assert(state->contexts == NULL && counters.heap_blocks == 2);
      cleanup_owner(state); finalize_owner(state->env, state, NULL); finalize_file(NULL, modeled_parent, NULL); assert_empty();
    }
  } else if (strncmp(argv[1], "process-", 8) == 0) {
    process_case = true;
    process_open_ok = strcmp(argv[1], "process-open-refusal") != 0;
    process_times_ok = strcmp(argv[1], "process-query-refusal") != 0;
    process_pid_ok = strcmp(argv[1], "process-identity-refusal") != 0;
    process_zero_birth = strcmp(argv[1], "process-zero-birth") == 0;
    if (strcmp(argv[1], "process-invalid-pid") == 0) process_pid = 0;
    if (strcmp(argv[1], "process-exited") == 0) process_wait = WAIT_OBJECT_0;
    if (strcmp(argv[1], "process-wait-refusal") == 0) process_wait = WAIT_FAILED;
    if (strcmp(argv[1], "process-unexpected-wait") == 0) process_wait = 128;
    close_ok = strcmp(argv[1], "process-close-unconfirmed") != 0;
    napi_value output = owner_observe_process(state->env, NULL);
    bool success = strcmp(argv[1], "process-running") == 0 || strcmp(argv[1], "process-exited") == 0;
    if (success) {
      assert(output == JS_RESULT && throws == 0 && close_calls == 1);
      assert(strcmp(observed_birth, "18446744073709551608") == 0);
      assert(strcmp(observed_process_state, process_wait == WAIT_OBJECT_0 ? "exited" : "running") == 0);
    } else {
      assert(output == NULL && throws == 1 && observed_birth[0] == 0 && observed_process_state[0] == 0);
      assert(close_calls == (process_open_ok && process_pid != 0 ? 1u : 0u));
    }
    assert(process_opens == (process_pid == 0 ? 0u : 1u));
    cleanup_owner(state); finalize_owner(state->env, state, NULL);
    if (close_ok) assert_empty();
    else assert(counters.open_processes == 1 && counters.heap_blocks == 2 && counters.unconfirmed_releases == 1 && close_calls == 1);
  } else if (strncmp(argv[1], "token-query-", 12) == 0) {
    thread_token = strcmp(argv[1], "token-query-impersonation") == 0;
    restricted_token = strcmp(argv[1], "token-query-restricted") == 0;
    partial_process_token = strcmp(argv[1], "token-query-partial") == 0;
    invalid_sid_pointer = strcmp(argv[1], "token-query-pointer") == 0;
    invalid_sid_length = strcmp(argv[1], "token-query-length") == 0;
    napi_value output = owner_token_user(state->env, NULL);
    if (strcmp(argv[1], "token-query-copied") == 0) {
      assert(output == JS_VALUE && copied_sid_bytes == 12 && sid_validation_calls == 1 && throws == 0);
    } else {
      assert(output == NULL && copied_sid_bytes == 0 && sid_validation_calls == 0 && throws == 1);
    }
    assert(counters.open_tokens == 0 && counters.heap_blocks == 1 && close_calls == 1);
    cleanup_owner(state);
    finalize_owner(state->env, state, NULL);
    assert_empty();
  } else if (strcmp(argv[1], "explicit-close") == 0 || strcmp(argv[1], "environment-cleanup") == 0) {
    file = make_file(state);
    file->locked = true;
    if (strcmp(argv[1], "explicit-close") == 0) {
      assert(retire_file(file, &error));
      assert(retire_file(file, &error));
      assert(close_calls == 1 && counters.open_files == 0 && !file->locked);
      assert(counters.file_records == 1 && counters.heap_blocks == counters.owners + counters.file_records);
    }
    cleanup_owner(state);
    assert(close_calls == 1 && counters.open_files == 0 && !file->locked);
    finalize_owner(state->env, state, NULL);
    assert(counters.heap_blocks == 2); /* File external still has a native owner reference. */
    finalize_file(NULL, file, NULL);
    assert(close_calls == 1);
    assert_empty();
  } else if (strcmp(argv[1], "close-unconfirmed") == 0) {
    file = make_file(state);
    close_ok = false;
    error = fail("primary failure", "native");
    assert(!retire_file(file, &error));
    assert(error.cleanup_failed && strcmp(error.operation, "primary failure") == 0);
    assert(file->handle == NULL && file->unconfirmed_handle != NULL);
    assert(!retire_file(file, &error));
    cleanup_owner(state);
    finalize_owner(state->env, state, NULL);
    finalize_file(NULL, file, NULL);
    assert(close_calls == 1 && counters.open_files == 1 && counters.unconfirmed_releases == 1);
    assert(counters.heap_blocks == 2);
  } else if (strcmp(argv[1], "token-release") == 0 || strcmp(argv[1], "token-unconfirmed") == 0
      || strcmp(argv[1], "local-release") == 0 || strcmp(argv[1], "local-unconfirmed") == 0) {
    bool token = strncmp(argv[1], "token", 5) == 0;
    bool uncertain = strstr(argv[1], "unconfirmed") != NULL;
    context = new_context(state, 128, &error);
    assert(context != NULL);
    if (token) { context->token = (HANDLE)(uintptr_t)101; counters.open_tokens++; close_ok = !uncertain; }
    else { context->descriptor = (PVOID)(uintptr_t)102; counters.local_blocks++; local_free_ok = !uncertain; }
    error = fail("primary failure", "privacy");
    release_context(context, &error);
    assert(strcmp(error.operation, "primary failure") == 0 && error.cleanup_failed == uncertain);
    if (uncertain) {
      release_context(context, &error);
      assert((token ? close_calls : local_free_calls) == 1);
      assert(state->quarantined && state->contexts == context && counters.heap_blocks == 2);
      assert(counters.unconfirmed_releases == 1);
    }
    cleanup_owner(state);
    finalize_owner(state->env, state, NULL);
    if (!uncertain) assert_empty();
  } else if (strcmp(argv[1], "pending-settled") == 0 || strcmp(argv[1], "pending-cancelled") == 0
      || strcmp(argv[1], "pending-quarantine") == 0) {
    file = make_file(state);
    context = new_context(state, 4096, &error);
    assert(context != NULL);
    waiting_context = context;
    complete_wait = strcmp(argv[1], "pending-settled") == 0 ? 1 : strcmp(argv[1], "pending-cancelled") == 0 ? 2 : 0;
    completed_status = complete_wait == 1 ? PS_SUCCESS : (NTSTATUS)0xc0000120u;
    if (complete_wait) {
      assert(complete_io(context, file->handle, PS_PENDING, "modeled IO", &error, &result));
      assert(result == completed_status && wait_calls == complete_wait && cancel_calls == complete_wait - 1);
      assert(counters.pending_contexts == 0);
      release_context(context, &error);
      cleanup_owner(state);
      finalize_owner(state->env, state, NULL);
      finalize_file(NULL, file, NULL);
      assert_empty();
    } else {
      assert(!complete_io(context, file->handle, PS_PENDING, "modeled IO", &error, &result));
      assert(error.pending && error.cleanup_failed && wait_calls == 2 && cancel_calls == 1);
      assert(counters.pending_contexts == 1 && counters.heap_blocks == 3);
      release_context(context, &error);
      cleanup_owner(state);
      finalize_owner(state->env, state, NULL);
      finalize_file(NULL, file, NULL);
      assert(counters.heap_blocks == 3 && counters.open_files == 1 && close_calls == 0);
      assert(quarantined_owners == state && state->contexts == context && state->files == file);
    }
  } else if (strncmp(argv[1], "open-rollback-", 14) == 0) {
    const char *scenario = argv[1] + 14;
    modeled_child = true; modeled_parent = make_file(state);
    modeled_kind = "file"; modeled_mode = "create";
    expected_options = 0x200062; expected_share = 1; expected_access = 0x130083; expected_disposition = 2;
    modeled_descriptor.Revision = SECURITY_DESCRIPTOR_REVISION;
    modeled_descriptor.Control = SE_SELF_RELATIVE;
    nt_create = modeled_create; nt_set = modeled_disposition;
    created_handle = (HANDLE)(uintptr_t)103;
    exposure_ok = strcmp(scenario, "tag") == 0; tag_ok = !exposure_ok;
    if (strcmp(scenario, "log-existing") == 0 || strcmp(scenario, "log-created") == 0) {
      modeled_mode = "log"; expected_disposition = 3; expected_access = 0x40120080;
      create_information = strcmp(scenario, "log-existing") == 0 ? 1 : 2;
    } else if (strcmp(scenario, "read-existing") == 0) {
      modeled_mode = "read"; expected_disposition = 1; expected_access = 0x120081;
      expected_options = 0x200060; expected_share = 5; create_information = 1;
    } else if (strcmp(scenario, "directory") == 0) {
      modeled_kind = "directory"; expected_access = 0x1300a1; expected_share = 3; expected_options = 0x200023;
    } else if (strcmp(scenario, "create-refused") == 0) create_status = (NTSTATUS)0xc0000034u;
    else if (strcmp(scenario, "create-pending") == 0) create_status = PS_PENDING;
    else if (strcmp(scenario, "create-unconfirmed") == 0) create_information = 0;
    else if (strcmp(scenario, "disposition-refused") == 0) disposition_status = (NTSTATUS)0xc0000022u;
    else if (strncmp(scenario, "disposition-pending-", 20) == 0) {
      disposition_status = PS_PENDING;
      if (strcmp(scenario, "disposition-pending-settled") == 0) complete_wait = 1;
      else if (strcmp(scenario, "disposition-pending-cancelled") == 0) {
        complete_wait = 2; completed_status = (NTSTATUS)0xc0000120u;
      } else assert(strcmp(scenario, "disposition-pending-quarantine") == 0);
    } else if (strcmp(scenario, "close-unconfirmed") == 0) close_ok = false;
    else assert(strcmp(scenario, "exposure") == 0 || strcmp(scenario, "tag") == 0);
    bool delete_expected = strcmp(modeled_mode, "create") == 0 && strcmp(modeled_kind, "file") == 0
      && create_status == PS_SUCCESS && create_information == 2;
    bool pending = create_status == PS_PENDING || (disposition_status == PS_PENDING && complete_wait == 0);
    bool quarantined = pending || !close_ok;
    assert(owner_open(state->env, NULL) == NULL && throws == 1);
    assert(disposition_calls == (delete_expected ? 1u : 0u));
    assert(strcmp(reported_operation, create_status != PS_SUCCESS ? "NtCreateFile"
      : exposure_ok ? "native file tag" : "native file exposure") == 0);
    assert(reported_cleanup_failed == (quarantined || (delete_expected && (disposition_status == (NTSTATUS)0xc0000022u
      || (disposition_status == PS_PENDING && completed_status != PS_SUCCESS)))));
    assert(reported_pending == pending);
    assert(close_calls == (pending ? 0u : 1u));
    assert(state->quarantined == quarantined);
    if (pending) {
      assert(wait_calls == 2 && cancel_calls == 1 && counters.pending_contexts == 1);
      assert(state->contexts != NULL && counters.open_files == 2);
    } else if (disposition_status == PS_PENDING) {
      assert(wait_calls == complete_wait && cancel_calls == complete_wait - 1 && counters.pending_contexts == 0);
    }
    cleanup_owner(state); finalize_owner(state->env, state, NULL);
    if (exposed_file != NULL) finalize_file(NULL, exposed_file, NULL);
    finalize_file(NULL, modeled_parent, NULL);
    if (quarantined) {
      assert(close_calls == (pending ? 0u : 1u));
      assert(disposition_calls == (delete_expected ? 1u : 0u));
      assert(counters.unconfirmed_releases == 1 && state->contexts != NULL);
    } else { assert(close_calls == 2); assert_empty(); }
  } else if (strncmp(argv[1], "open-policy-", 12) == 0) {
    const char *policy = argv[1] + 12;
    modeled_child = true; modeled_parent = make_file(state);
    modeled_kind = "file"; modeled_mode = policy;
    expected_options = 0x200060; expected_share = 7; expected_access = 0x120080;
    modeled_descriptor.Revision = SECURITY_DESCRIPTOR_REVISION;
    modeled_descriptor.Control = SE_SELF_RELATIVE;
    if (strcmp(policy, "create") == 0) {
      expected_share = 1; expected_access |= 0x10003; expected_disposition = 2; expected_options |= 2;
    } else if (strcmp(policy, "log") == 0) {
      expected_share = 1; expected_access |= 0x40000000u; expected_disposition = 3; expected_options |= 2;
    } else if (strcmp(policy, "read-source") == 0) { expected_share = 1; expected_access |= 1; }
    else if (strcmp(policy, "read-link") == 0) { modeled_kind = "any"; expected_options = 0x200020; expected_share = 1; }
    else if (strcmp(policy, "read") == 0) { expected_share = 5; expected_access |= 1; }
    else if (strcmp(policy, "lock") == 0) { expected_share = 3; expected_access |= 3; }
    else if (strcmp(policy, "delete") == 0) { expected_access |= 0x10000; }
    else assert(strcmp(policy, "inspect") == 0);
    nt_create = modeled_create; created_handle = (HANDLE)(uintptr_t)103; exposure_ok = true; create_status = PS_SUCCESS;
    assert(owner_open(state->env, NULL) == JS_RESULT && throws == 0 && exposure_registered);
    cleanup_owner(state);
    finalize_owner(state->env, state, NULL);
    finalize_file(NULL, exposed_file, NULL);
    finalize_file(NULL, modeled_parent, NULL);
    assert_empty();
  } else if (strcmp(argv[1], "open-exposure-rollback") == 0 || strcmp(argv[1], "open-partial-rollback") == 0
      || strcmp(argv[1], "open-registered") == 0 || strcmp(argv[1], "open-pending-quarantine") == 0) {
    nt_create = modeled_create;
    created_handle = (HANDLE)(uintptr_t)103;
    exposure_ok = strcmp(argv[1], "open-registered") == 0;
    create_status = strcmp(argv[1], "open-partial-rollback") == 0 ? (NTSTATUS)0xc0000034u
      : strcmp(argv[1], "open-pending-quarantine") == 0 ? PS_PENDING : PS_SUCCESS;
    napi_value output = owner_open(state->env, NULL);
    if (exposure_ok) {
      assert(output == JS_RESULT && exposure_registered && throws == 0 && close_calls == 0);
      assert(counters.heap_blocks == 2 && counters.open_files == 1);
      cleanup_owner(state);
      finalize_owner(state->env, state, NULL);
      finalize_file(NULL, exposed_file, NULL);
      assert_empty();
    } else if (create_status == PS_PENDING) {
      assert(output == NULL && throws == 1 && close_calls == 0 && !exposure_registered);
      assert(counters.heap_blocks == 3 && counters.pending_contexts == 1 && counters.open_files == 1);
      cleanup_owner(state);
      finalize_owner(state->env, state, NULL);
      assert(counters.heap_blocks == 3 && counters.open_files == 1);
    } else {
      assert(output == NULL && throws == 1 && close_calls == 1);
      assert(exposure_registered == (create_status == PS_SUCCESS));
      assert(counters.heap_blocks == 1 && counters.open_files == 0 && state->files == NULL);
      cleanup_owner(state);
      finalize_owner(state->env, state, NULL);
      assert_empty();
    }
  } else if (strcmp(argv[1], "sequential-closed-limit") == 0 || strcmp(argv[1], "simultaneous-live-limit") == 0) {
    bool sequential = strcmp(argv[1], "sequential-closed-limit") == 0;
    size_t count = sequential ? FILE_LIMIT + 32u : FILE_LIMIT;
    nt_create = modeled_create;
    created_handle = (HANDLE)(uintptr_t)103;
    exposure_ok = true;
    create_status = PS_SUCCESS;
    for (size_t index = 0; index < count; ++index) {
      assert(owner_open(state->env, NULL) == JS_RESULT && throws == 0);
      if (sequential) {
        assert(retire_file(exposed_file, &error));
        assert(exposed_file->handle == NULL && state->live_file_count == 0 && counters.open_files == 0);
      }
    }
    assert(state->file_count == count);
    if (!sequential) {
      assert(state->live_file_count == FILE_LIMIT && counters.open_files == FILE_LIMIT);
      assert(owner_open(state->env, NULL) == NULL && throws == 1);
      assert(state->file_count == FILE_LIMIT && state->live_file_count == FILE_LIMIT);
      assert(retire_file(exposed_file, &error));
      assert(state->live_file_count == FILE_LIMIT - 1);
      throws = 0;
      assert(owner_open(state->env, NULL) == JS_RESULT && throws == 0);
      assert(state->file_count == FILE_LIMIT + 1 && state->live_file_count == FILE_LIMIT);
    }
    cleanup_owner(state);
    assert(state->live_file_count == 0 && counters.open_files == 0);
    finalize_owner(state->env, state, NULL);
    file = state->files;
    while (file != NULL) {
      owned_file *next = file->next;
      finalize_file(NULL, file, NULL);
      file = next;
    }
    assert_empty();
  } else { assert(!"Unknown ownership model scenario"); }
  printf("{\"evidence\":\"synthetic-c-ownership-model\",\"nativeExecution\":false,\"scenario\":\"%s\",\"passed\":true}\n", argv[1]);
  return 0;
}
