/* Test-only source instrumentation. The included production translation unit is byte-pinned
 * by owner-fault-support.mjs and the SDK build record. Never ship this module.
 * Faults alter a completed call's return/buffer, except explicit calloc/exposure refusal.
 * Nothing here claims a genuine allocator, kernel release, or pending-request failure. */
#define _WIN32_WINNT 0x0602
#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <node_api.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#define OF_MAX 4096u
#define OF_PENDING ((NTSTATUS)0x103)
#define OF_FAILURE ((NTSTATUS)0xc0000001L)
#define OF_EOF ((NTSTATUS)0xc0000011L)
#define OF_DONE ((NTSTATUS)0x80000006L)
typedef NTSTATUS (NTAPI *of_create_fn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *of_query_fn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *of_rw_fn)(HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG, PLARGE_INTEGER, PULONG);
typedef NTSTATUS (NTAPI *of_dir_fn)(HANDLE, HANDLE, PVOID, PVOID, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG, BOOLEAN, PUNICODE_STRING, BOOLEAN);
typedef struct { const char *name, *role, *origin; double actual, visible; unsigned ordinal; bool forwarded, injected, released; } of_event;
typedef struct { void *pointer; const char *role; bool live; } of_resource;
static struct {
  char fault[96]; unsigned ordinal, allocs, exposures, queries, count, injections, violations;
  bool active, fired, cleanup_fired, write_fired, actual_pending, overflow;
  of_event events[OF_MAX]; of_resource handles[OF_MAX], blocks[OF_MAX], descriptors[OF_MAX];
} of_state;
static of_create_fn of_real_create;
static of_query_fn of_real_query, of_real_volume, of_real_set;
static of_rw_fn of_real_read, of_real_write;
static of_dir_fn of_real_directory;

static bool of_is(const char *name) { return of_state.active && strcmp(of_state.fault, name) == 0; }
static bool of_take(const char *name) { if (!of_is(name) || of_state.fired) return false; of_state.fired = true; return true; }
static of_event *of_event_new(const char *name, double actual, bool forwarded) {
  of_event *event;
  if (!of_state.active) return NULL;
  if (of_state.count == OF_MAX) { of_state.overflow = true; return NULL; }
  event = &of_state.events[of_state.count++]; memset(event, 0, sizeof(*event));
  event->name = name; event->actual = actual; event->visible = actual; event->forwarded = forwarded;
  return event;
}
static void of_inject(of_event *event, double visible, const char *origin) {
  if (event == NULL) { of_state.violations++; return; }
  event->injected = true; event->visible = visible; event->origin = origin; of_state.injections++;
}
static of_resource *of_find(of_resource *list, void *pointer) {
  unsigned i; for (i = 0; i < OF_MAX; i++) if (list[i].live && list[i].pointer == pointer) return &list[i];
  return NULL;
}
static void of_acquire(of_resource *list, void *pointer, const char *role) {
  unsigned i;
  if (pointer == NULL || pointer == INVALID_HANDLE_VALUE) return;
  if (of_find(list, pointer) != NULL) { of_state.violations++; return; }
  for (i = 0; i < OF_MAX; i++) if (!list[i].live) { list[i].pointer = pointer; list[i].live = true; list[i].role = role; return; }
  of_state.violations++;
}
static unsigned of_live(of_resource *list) { unsigned i, n = 0; for (i = 0; i < OF_MAX; i++) if (list[i].live) n++; return n; }
static void *of_calloc(size_t count, size_t bytes) {
  void *value; of_event *event;
  if (of_state.active) of_state.allocs++;
  if (of_is("alloc") && of_state.allocs == of_state.ordinal && !of_state.fired) {
    of_state.fired = true; event = of_event_new("calloc", 0, false);
    if (event) event->ordinal = of_state.allocs;
    of_inject(event, 0, "test-owned-allocation-refusal"); return NULL;
  }
  value = calloc(count, bytes); of_acquire(of_state.blocks, value, "heap");
  event = of_event_new("calloc", value != NULL, true); if (event) event->ordinal = of_state.allocs;
  return value;
}
static void of_free(void *value) {
  of_resource *resource = of_find(of_state.blocks, value); of_event *event;
  if (value == NULL) return;
  if (resource == NULL) { of_state.violations++; return; }
  free(value); resource->live = false; event = of_event_new("free", 0, true); if (event) event->released = true;
}
static HANDLE WINAPI of_OpenProcess(DWORD access, BOOL inherit, DWORD pid) {
  HANDLE result = OpenProcess(access, inherit, pid); DWORD error = GetLastError();
  of_event_new("OpenProcess", result != NULL, true); of_acquire(of_state.handles, result, "process");
  SetLastError(error); return result;
}
static BOOL WINAPI of_OpenThreadToken(HANDLE thread, DWORD access, BOOL self, PHANDLE token) {
  BOOL result = OpenThreadToken(thread, access, self, token); DWORD error = GetLastError();
  of_event_new("OpenThreadToken", result, true); if (result) of_acquire(of_state.handles, *token, "token");
  SetLastError(error); return result;
}
static BOOL WINAPI of_OpenProcessToken(HANDLE process, DWORD access, PHANDLE token) {
  BOOL result = OpenProcessToken(process, access, token); DWORD error = GetLastError();
  of_event *event = of_event_new("OpenProcessToken", result, true);
  if (result) of_acquire(of_state.handles, *token, "token");
  if (result && of_take("open-token")) { result = FALSE; error = ERROR_ACCESS_DENIED; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static BOOL WINAPI of_GetTokenInformation(HANDLE token, TOKEN_INFORMATION_CLASS cls, LPVOID buffer, DWORD size, PDWORD needed) {
  BOOL result = GetTokenInformation(token, cls, buffer, size, needed); DWORD error = GetLastError();
  of_event *event = of_event_new(buffer == NULL ? "GetTokenInformation size" : "GetTokenInformation data", result, true);
  if ((buffer == NULL && !result && error == ERROR_INSUFFICIENT_BUFFER && of_take("token-size"))
    || (buffer != NULL && result && of_take("token-read"))) {
    result = FALSE; error = ERROR_ACCESS_DENIED; of_inject(event, result, "test-owned-return");
  }
  SetLastError(error); return result;
}
static BOOL WINAPI of_CloseHandle(HANDLE handle) {
  of_resource *resource = of_find(of_state.handles, handle); BOOL result; DWORD error; of_event *event;
  const char *role;
  if (resource == NULL) { of_state.violations++; SetLastError(ERROR_INVALID_HANDLE); return FALSE; }
  role = resource->role; result = CloseHandle(handle); error = GetLastError(); event = of_event_new("CloseHandle", result, true);
  if (event) { event->role = role; event->released = result != FALSE; }
  if (result) resource->live = false;
  if (result && !of_state.cleanup_fired && ((of_is("token-close") && strcmp(role, "token") == 0)
    || (of_is("file-close") && strcmp(role, "file") == 0)
    || (of_is("directory-close") && strcmp(role, "directory") == 0)
    || (of_is("staging-close") && strcmp(role, "staging") == 0))) {
    of_state.cleanup_fired = true; result = FALSE; error = ERROR_INVALID_HANDLE; of_inject(event, result, "test-owned-return");
  }
  SetLastError(error); return result;
}
static DWORD WINAPI of_GetSecurityInfo(HANDLE h, SE_OBJECT_TYPE kind, SECURITY_INFORMATION info, PSID *owner_sid, PSID *group, PACL *dacl, PACL *sacl, PSECURITY_DESCRIPTOR *descriptor) {
  DWORD result = GetSecurityInfo(h, kind, info, owner_sid, group, dacl, sacl, descriptor);
  of_event *event = of_event_new("GetSecurityInfo", result, true);
  if (*descriptor != NULL) of_acquire(of_state.descriptors, *descriptor, "descriptor");
  if (result == ERROR_SUCCESS && of_take("security")) { result = ERROR_ACCESS_DENIED; of_inject(event, result, "test-owned-return"); }
  return result;
}
static DWORD WINAPI of_GetSecurityDescriptorLength(PSECURITY_DESCRIPTOR descriptor) {
  DWORD result = GetSecurityDescriptorLength(descriptor); of_event *event = of_event_new("GetSecurityDescriptorLength", result, true);
  if (result > 0 && of_take("security-length")) { result = 65537; of_inject(event, result, "test-owned-return"); }
  return result;
}
static HLOCAL WINAPI of_LocalFree(HLOCAL value) {
  of_resource *resource = of_find(of_state.descriptors, value); HLOCAL result; DWORD error; of_event *event;
  if (resource == NULL) { of_state.violations++; SetLastError(ERROR_INVALID_HANDLE); return value; }
  result = LocalFree(value); error = GetLastError(); event = of_event_new("LocalFree", result != NULL, true);
  if (event) event->released = result == NULL;
  if (result == NULL) resource->live = false;
  if (result == NULL && of_take("local-free")) { of_state.cleanup_fired = true; result = value; error = ERROR_INVALID_HANDLE; of_inject(event, 1, "test-owned-return"); }
  SetLastError(error); return result;
}
static DWORD WINAPI of_GetFileType(HANDLE handle) {
  DWORD result = GetFileType(handle), error = GetLastError(); of_event *event = of_event_new("GetFileType", result, true);
  if (result != FILE_TYPE_UNKNOWN && of_take("file-type")) { result = FILE_TYPE_UNKNOWN; error = ERROR_INVALID_HANDLE; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static BOOL WINAPI of_GetFileInformationByHandleEx(HANDLE h, FILE_INFO_BY_HANDLE_CLASS cls, LPVOID buffer, DWORD size) {
  BOOL result = GetFileInformationByHandleEx(h, cls, buffer, size); DWORD error = GetLastError();
  of_event *event = of_event_new("GetFileInformationByHandleEx", result, true);
  if (result && of_take("file-id")) { result = FALSE; error = ERROR_INVALID_HANDLE; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static BOOL WINAPI of_GetVolumeInformationByHandleW(HANDLE h, LPWSTR name, DWORD size, LPDWORD serial, LPDWORD max, LPDWORD flags, LPWSTR fs, DWORD fs_size) {
  BOOL result = GetVolumeInformationByHandleW(h, name, size, serial, max, flags, fs, fs_size); DWORD error = GetLastError();
  of_event *event = of_event_new("GetVolumeInformationByHandleW", result, true);
  if (result && of_take("volume")) { result = FALSE; error = ERROR_INVALID_HANDLE; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static NTSTATUS of_pending(NTSTATUS result, PIO_STATUS_BLOCK ios, of_event *event) {
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (result != 0 || of_state.fired || !of_state.active) return result;
  if (of_is("pending-settled") || of_is("pending-unsettled") || of_is("pending-wait-error")) {
    of_state.fired = true;
    if (!of_is("pending-settled")) ios->Status = OF_PENDING;
    of_inject(event, OF_PENDING, "test-owned-return-and-completion"); return OF_PENDING;
  }
  return result;
}
static NTSTATUS NTAPI of_NtCreateFile(PHANDLE out, ACCESS_MASK access, POBJECT_ATTRIBUTES attr, PIO_STATUS_BLOCK ios, PLARGE_INTEGER length, ULONG attributes, ULONG share, ULONG disposition, ULONG options, PVOID ea, ULONG ea_length) {
  NTSTATUS result = of_real_create(out, access, attr, ios, length, attributes, share, disposition, options, ea, ea_length);
  of_event *event = of_event_new("NtCreateFile", result, true); const char *role = disposition == 2 ? "staging" : (options & 1) ? "directory" : "file";
  if (*out != NULL && *out != INVALID_HANDLE_VALUE) of_acquire(of_state.handles, *out, role);
  if (event) event->role = role;
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (result == 0 && of_take("open-file")) { result = OF_FAILURE; of_inject(event, result, "test-owned-return"); }
  return result;
}
static NTSTATUS of_query_call(of_query_fn call, const char *name, const char *fault, HANDLE h, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, ULONG cls) {
  NTSTATUS result = call(h, ios, data, length, cls); of_event *event = of_event_new(name, result, true);
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (result == 0) {
    if (of_take(fault)) { result = OF_FAILURE; of_inject(event, result, "test-owned-return"); }
    else if (of_take("query-short")) { ios->Information = 0; of_inject(event, result, "test-owned-buffer"); }
    else if (of_take("query-oversize")) { ios->Information = (ULONG_PTR)length + 1; of_inject(event, result, "test-owned-buffer"); }
  }
  return result;
}
static NTSTATUS NTAPI of_NtQueryInformationFile(HANDLE h, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, ULONG cls) { return of_query_call(of_real_query, "NtQueryInformationFile", "native-query", h, ios, data, length, cls); }
static NTSTATUS NTAPI of_NtQueryVolumeInformationFile(HANDLE h, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, ULONG cls) { return of_query_call(of_real_volume, "NtQueryVolumeInformationFile", "native-volume", h, ios, data, length, cls); }
static NTSTATUS NTAPI of_NtSetInformationFile(HANDLE h, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, ULONG cls) {
  NTSTATUS result = of_real_set(h, ios, data, length, cls); of_event *event = of_event_new("NtSetInformationFile", result, true);
  of_resource *resource = of_find(of_state.handles, h);
  if (event && cls == 13 && resource != NULL) event->role = resource->role;
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (result == 0 && cls == 13 && of_take("staging-disposition")) { of_state.cleanup_fired = true; if (event) event->released = true; result = OF_FAILURE; of_inject(event, result, "test-owned-return"); }
  return result;
}
static NTSTATUS NTAPI of_NtReadFile(HANDLE h, HANDLE e, PVOID apc, PVOID user, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, PLARGE_INTEGER offset, PULONG key) {
  NTSTATUS result = of_real_read(h, e, apc, user, ios, data, length, offset, key); of_event *event = of_event_new("NtReadFile", result, true);
  if (result == 0) {
    if (of_take("read-failure")) { result = OF_FAILURE; of_inject(event, result, "test-owned-return"); }
    else if (of_take("read-zero")) { ios->Information = 0; of_inject(event, result, "test-owned-buffer"); }
    else if (of_take("read-overrun")) { ios->Information = (ULONG_PTR)length + 1; of_inject(event, result, "test-owned-buffer"); }
    else if (ios->Information > 1 && of_take("read-short")) { ios->Information--; of_inject(event, result, "test-owned-buffer"); }
  } else if (result == OF_EOF && length == 1 && of_take("read-extra-tail")) {
    ((unsigned char *)data)[0] = 88; ios->Information = 1; ios->Status = 0; result = 0; of_inject(event, result, "test-owned-buffer");
  }
  return of_pending(result, ios, event);
}
static NTSTATUS NTAPI of_NtWriteFile(HANDLE h, HANDLE e, PVOID apc, PVOID user, PIO_STATUS_BLOCK ios, PVOID data, ULONG length, PLARGE_INTEGER offset, PULONG key) {
  NTSTATUS result = of_real_write(h, e, apc, user, ios, data, length, offset, key); of_event *event = of_event_new("NtWriteFile", result, true);
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (result == 0 && !of_state.write_fired && (of_is("staging-close") || of_is("staging-disposition"))) {
    of_state.write_fired = true; result = OF_FAILURE; of_inject(event, result, "test-owned-return");
  }
  return result;
}
static NTSTATUS NTAPI of_NtQueryDirectoryFile(HANDLE h, HANDLE e, PVOID apc, PVOID user, PIO_STATUS_BLOCK ios, PVOID data, ULONG capacity, ULONG cls, BOOLEAN single, PUNICODE_STRING pattern, BOOLEAN restart) {
  NTSTATUS result; of_event *event; DWORD bytes = 20, next = 0; ULONG_PTR length = 32; const char *mode = of_state.fault;
  /* Watchdog returns an error only after recording overflow; this can never pass a row. */
  if (of_state.active && ++of_state.queries > 64) { of_state.overflow = true; event = of_event_new("NtQueryDirectoryFile watchdog", OF_FAILURE, false); of_inject(event, OF_FAILURE, "test-watchdog-refusal"); return OF_FAILURE; }
  result = of_real_directory(h, e, apc, user, ios, data, capacity, cls, single, pattern, restart);
  event = of_event_new("NtQueryDirectoryFile", result, true);
  if (result == OF_PENDING) of_state.actual_pending = true;
  if (!of_state.active || capacity != 65536 || cls != 12) return result;
  if (of_is("total-query-ceiling") && (result == 0 || result == OF_DONE)) {
    memset(data, 0, capacity); bytes = 2; memcpy((unsigned char *)data + 8, &bytes, 4); ((WCHAR *)((unsigned char *)data + 12))[0] = L'.';
    ios->Information = 14; ios->Status = 0; of_state.fired = true; of_inject(event, 0, "test-owned-buffer"); return 0;
  }
  if (result != 0) return result;
  result = of_pending(result, ios, event);
  if (of_state.fired) return result;
  if (of_take("native-failure") || of_take("warning-return")) { result = of_is("warning-return") ? (NTSTATUS)0x80000005L : OF_FAILURE; ios->Status = result; of_inject(event, result, "test-owned-return"); return result; }
  if (strcmp(mode, "truncated-header") == 0) length = 11;
  else if (strcmp(mode, "overlong-buffer") == 0) length = capacity + 1;
  else if (strcmp(mode, "odd-name-length") == 0) bytes = 1;
  else if (strcmp(mode, "zero-name-length") == 0) bytes = 0;
  else if (strcmp(mode, "name-overruns-page") == 0) bytes = 22;
  else if (strcmp(mode, "next-record-truncated") == 0) next = 32;
  else if (strcmp(mode, "next-offset-overlap") == 0) next = 12;
  else if (strcmp(mode, "next-offset-unaligned") == 0) next = 33;
  else if (strcmp(mode, "next-offset-overlong") == 0) next = 65532;
  else return result;
  memset(data, 0, capacity); memcpy((unsigned char *)data + 12, L"record.bin", 20);
  memcpy(data, &next, 4); memcpy((unsigned char *)data + 8, &bytes, 4); ios->Information = length; ios->Status = 0;
  of_state.fired = true; of_inject(event, 0, "test-owned-buffer"); return 0;
}
static DWORD WINAPI of_WaitForSingleObject(HANDLE handle, DWORD milliseconds) {
  DWORD result = WaitForSingleObject(handle, milliseconds), error = GetLastError(); of_event *event = of_event_new("WaitForSingleObject", result, true);
  if (!of_state.actual_pending && of_state.fired && (of_is("pending-unsettled") || of_is("pending-wait-error"))) {
    result = of_is("pending-wait-error") ? WAIT_FAILED : WAIT_TIMEOUT; error = ERROR_INVALID_HANDLE; of_inject(event, result, "test-owned-return");
  }
  SetLastError(error); return result;
}
static BOOL WINAPI of_CancelIoEx(HANDLE handle, LPOVERLAPPED overlap) {
  BOOL result = CancelIoEx(handle, overlap); DWORD error = GetLastError(); of_event_new("CancelIoEx", result, true); SetLastError(error); return result;
}
static BOOL WINAPI of_LockFileEx(HANDLE h, DWORD flags, DWORD reserved, DWORD low, DWORD high, LPOVERLAPPED overlap) {
  BOOL result = LockFileEx(h, flags, reserved, low, high, overlap); DWORD error = GetLastError(); of_event *event = of_event_new("LockFileEx", result, true);
  if (!result && error == ERROR_IO_PENDING) of_state.actual_pending = true;
  if (result && of_take("lock-failure")) { result = FALSE; error = ERROR_LOCK_VIOLATION; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static BOOL WINAPI of_UnlockFileEx(HANDLE h, DWORD reserved, DWORD low, DWORD high, LPOVERLAPPED overlap) {
  BOOL result = UnlockFileEx(h, reserved, low, high, overlap); DWORD error = GetLastError(); of_event *event = of_event_new("UnlockFileEx", result, true);
  if (!result && error == ERROR_IO_PENDING) of_state.actual_pending = true;
  if (result && (of_take("unlock-failure") || of_take("unlock"))) { if (event) event->released = true; of_state.cleanup_fired = true; result = FALSE; error = ERROR_NOT_LOCKED; of_inject(event, result, "test-owned-return"); }
  SetLastError(error); return result;
}
static bool of_exposure(const char *name) {
  of_event *event;
  if (!of_state.active) return false;
  of_state.exposures++;
  if (!of_is("view") || of_state.exposures != of_state.ordinal || of_state.fired) return false;
  of_state.fired = true; event = of_event_new(name, napi_generic_failure, false); if (event) event->ordinal = of_state.exposures;
  of_inject(event, napi_generic_failure, "test-owned-result-exposure-refusal"); return true;
}
static napi_status NAPI_CDECL of_napi_create_buffer_copy(napi_env env, size_t length, const void *data, void **copy, napi_value *value) {
  napi_status result; of_event *event;
  if (of_exposure("napi_create_buffer_copy")) return napi_generic_failure;
  result = napi_create_buffer_copy(env, length, data, copy, value); event = of_event_new("napi_create_buffer_copy", result, true); if (event) event->ordinal = of_state.exposures; return result;
}
static napi_status NAPI_CDECL of_napi_create_external(napi_env env, void *data, napi_finalize finalizer, void *hint, napi_value *value) {
  napi_status result; of_event *event;
  if (of_exposure("napi_create_external")) return napi_generic_failure;
  result = napi_create_external(env, data, finalizer, hint, value); event = of_event_new("napi_create_external", result, true); if (event) event->ordinal = of_state.exposures; return result;
}
static FARPROC WINAPI of_GetProcAddress(HMODULE module, LPCSTR name) {
  FARPROC actual = GetProcAddress(module, name), replacement = actual;
  /* memcpy avoids a mismatched function-pointer call or compiler cast suppression. */
#define OF_COPY(symbol, target, wrapper, type) if (strcmp(name, symbol) == 0 && actual != NULL) { \
    type value = wrapper; _Static_assert(sizeof(target) == sizeof(actual), "pointer width"); \
    memcpy(&target, &actual, sizeof(target)); memcpy(&replacement, &value, sizeof(replacement)); }
  OF_COPY("NtCreateFile", of_real_create, of_NtCreateFile, of_create_fn)
  OF_COPY("NtQueryInformationFile", of_real_query, of_NtQueryInformationFile, of_query_fn)
  OF_COPY("NtQueryVolumeInformationFile", of_real_volume, of_NtQueryVolumeInformationFile, of_query_fn)
  OF_COPY("NtSetInformationFile", of_real_set, of_NtSetInformationFile, of_query_fn)
  OF_COPY("NtReadFile", of_real_read, of_NtReadFile, of_rw_fn)
  OF_COPY("NtWriteFile", of_real_write, of_NtWriteFile, of_rw_fn)
  OF_COPY("NtQueryDirectoryFile", of_real_directory, of_NtQueryDirectoryFile, of_dir_fn)
#undef OF_COPY
  return replacement;
}

#define calloc of_calloc
#define free of_free
#define OpenProcess of_OpenProcess
#define OpenThreadToken of_OpenThreadToken
#define OpenProcessToken of_OpenProcessToken
#define GetTokenInformation of_GetTokenInformation
#define CloseHandle of_CloseHandle
#define GetSecurityInfo of_GetSecurityInfo
#define GetSecurityDescriptorLength of_GetSecurityDescriptorLength
#define LocalFree of_LocalFree
#define GetFileType of_GetFileType
#define GetFileInformationByHandleEx of_GetFileInformationByHandleEx
#define GetVolumeInformationByHandleW of_GetVolumeInformationByHandleW
#define WaitForSingleObject of_WaitForSingleObject
#define CancelIoEx of_CancelIoEx
#define LockFileEx of_LockFileEx
#define UnlockFileEx of_UnlockFileEx
#define GetProcAddress of_GetProcAddress
#define napi_create_buffer_copy of_napi_create_buffer_copy
#define napi_create_external of_napi_create_external
#undef NAPI_MODULE_INIT
#define NAPI_MODULE_INIT() static napi_value of_production_initializer(napi_env env, napi_value exports)
#include "../../../../../native/system/packages/entry/src/windows-private-owner.c"
#undef calloc
#undef free
#undef OpenProcess
#undef OpenThreadToken
#undef OpenProcessToken
#undef GetTokenInformation
#undef CloseHandle
#undef GetSecurityInfo
#undef GetSecurityDescriptorLength
#undef LocalFree
#undef GetFileType
#undef GetFileInformationByHandleEx
#undef GetVolumeInformationByHandleW
#undef WaitForSingleObject
#undef CancelIoEx
#undef LockFileEx
#undef UnlockFileEx
#undef GetProcAddress
#undef napi_create_buffer_copy
#undef napi_create_external

static napi_value of_arm(napi_env env, napi_callback_info info) {
  napi_value args[2]; size_t argc = 2, length; uint32_t ordinal;
  if (napi_get_cb_info(env, info, &argc, args, NULL, NULL) != napi_ok || argc != 2
    || napi_get_value_string_utf8(env, args[0], of_state.fault, sizeof(of_state.fault), &length) != napi_ok
    || length >= sizeof(of_state.fault) || napi_get_value_uint32(env, args[1], &ordinal) != napi_ok
    || ordinal > OF_MAX) return throw_failure(env, fail("fixture arm arguments", "fixture"));
  of_state.ordinal = ordinal; of_state.allocs = 0; of_state.exposures = 0; of_state.queries = 0; of_state.count = 0;
  of_state.injections = 0; of_state.fired = false; of_state.cleanup_fired = false; of_state.write_fired = false;
  of_state.active = true; return NULL;
}
static napi_value of_reset(napi_env env, napi_callback_info info) {
  (void)env; (void)info;
  /* Disarm only: never erase live resources, quarantines, violations, or overflow. */
  of_state.active = false; return NULL;
}
static napi_value of_report(napi_env env, napi_callback_info info) {
  napi_value result, array, item, value; unsigned i; bool active = of_state.active;
  (void)info; of_state.active = false;
  if (napi_create_object(env, &result) != napi_ok || napi_create_array(env, &array) != napi_ok) return NULL;
#define OF_NUMBER(object, name, number) do { if (napi_create_double(env, (double)(number), &value) != napi_ok || napi_set_named_property(env, object, name, value) != napi_ok) return NULL; } while (0)
#define OF_BOOL(object, name, boolean) do { if (napi_get_boolean(env, boolean, &value) != napi_ok || napi_set_named_property(env, object, name, value) != napi_ok) return NULL; } while (0)
#define OF_TEXT(object, name, text) do { if (napi_create_string_utf8(env, text, NAPI_AUTO_LENGTH, &value) != napi_ok || napi_set_named_property(env, object, name, value) != napi_ok) return NULL; } while (0)
  OF_TEXT(result, "productionSourceSha256", "35b98bc2a0b577e9a680535b199bcf12fd52d41a9fff112bfe19705b53d773e8");
  OF_NUMBER(result, "allocations", of_state.allocs); OF_NUMBER(result, "exposures", of_state.exposures);
  OF_NUMBER(result, "queryCalls", of_state.queries); OF_NUMBER(result, "injections", of_state.injections);
  OF_NUMBER(result, "protocolViolations", of_state.violations); OF_BOOL(result, "overflow", of_state.overflow);
  OF_BOOL(result, "actualPendingRequest", of_state.actual_pending); OF_BOOL(result, "faultInjected", of_state.injections > 0);
  OF_BOOL(result, "writeFailureInjected", of_state.write_fired); OF_BOOL(result, "cleanupFailureInjected", of_state.cleanup_fired);
  OF_NUMBER(result, "liveNativeHandles", of_live(of_state.handles)); OF_NUMBER(result, "liveNativeHeapBlocks", of_live(of_state.blocks));
  OF_NUMBER(result, "liveNativeDescriptors", of_live(of_state.descriptors));
  OF_NUMBER(result, "pendingContexts", counters.pending_contexts); OF_NUMBER(result, "quarantinedOwners", counters.unconfirmed_releases);
  OF_NUMBER(result, "owners", counters.owners); OF_NUMBER(result, "fileRecords", counters.file_records);
  OF_NUMBER(result, "retainedContexts", counters.heap_blocks - counters.owners - counters.file_records);
  for (i = 0; i < of_state.count; i++) {
    const of_event *event = &of_state.events[i];
    if (napi_create_object(env, &item) != napi_ok) return NULL;
    OF_TEXT(item, "name", event->name); OF_BOOL(item, "forwarded", event->forwarded); OF_BOOL(item, "injected", event->injected);
    if (event->forwarded) OF_NUMBER(item, "actualReturn", event->actual);
    OF_NUMBER(item, "visibleReturn", event->visible); OF_BOOL(item, "actuallyReleased", event->released);
    if (event->origin) OF_TEXT(item, "injectionOrigin", event->origin);
    if (event->role) OF_TEXT(item, "role", event->role);
    if (event->ordinal) OF_NUMBER(item, "ordinal", event->ordinal);
    if (napi_set_element(env, array, i, item) != napi_ok) return NULL;
  }
  if (napi_set_named_property(env, result, "trace", array) != napi_ok) return NULL;
#undef OF_NUMBER
#undef OF_BOOL
#undef OF_TEXT
  of_state.active = active; return result;
}
#undef NAPI_MODULE_INIT
/* The production initializer is static; only these four test-fixture functions export. */
NAPI_MODULE_EXPORT napi_value NAPI_MODULE_INITIALIZER(napi_env env, napi_value exports) {
  napi_value factory;
  const napi_property_descriptor methods[] = {
    { "arm", NULL, of_arm, NULL, NULL, NULL, napi_default, NULL },
    { "report", NULL, of_report, NULL, NULL, NULL, napi_default, NULL },
    { "reset", NULL, of_reset, NULL, NULL, NULL, napi_default, NULL }
  };
  if (of_production_initializer(env, exports) == NULL
    || napi_get_named_property(env, exports, "createOwner", &factory) != napi_ok
    || napi_define_properties(env, exports, sizeof(methods) / sizeof(methods[0]), methods) != napi_ok) return NULL;
  return exports;
}
NAPI_MODULE_EXPORT int32_t NODE_API_MODULE_GET_API_VERSION(void) { return NAPI_VERSION; }
