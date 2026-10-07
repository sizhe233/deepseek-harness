/* Test-only SDK launcher/child. No privileges, tokens, services or production addon. */
#define WIN32_LEAN_AND_MEAN
#define _CRT_SECURE_NO_WARNINGS
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef WINVER
#define WINVER _WIN32_WINNT
#endif
#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

#ifdef DSH_FIXTURE_DLL
#include <processsnapshot.h>
_Static_assert(sizeof(FILE_ID_INFO) == 24, "SDK full identity wire width");

/* SDK-only discovery in this process. No PID, process handle, name or memory input. */
__declspec(dllexport) DWORD WINAPI dsh_snapshot_matching_files(
  const BYTE *identities, DWORD identityCount, BYTE *output, DWORD capacity,
  DWORD *records, DWORD *visited) {
  HPSS snapshot = NULL;
  HPSSWALK marker = NULL;
  DWORD error, cleanup;
  if (!identities || !identityCount || identityCount > 1024 || !output
    || !capacity || capacity > 4096 || !records || !visited) return ERROR_INVALID_PARAMETER;
  *records = 0; *visited = 0;
  /* PSS_CAPTURE_HANDLES captures the handle table without a VA clone or threads. */
  error = PssCaptureSnapshot(GetCurrentProcess(), PSS_CAPTURE_HANDLES, 0, &snapshot);
  if (error != ERROR_SUCCESS) return error;
  error = PssWalkMarkerCreate(NULL, &marker);
  if (error != ERROR_SUCCESS) goto done;
  for (;;) {
    PSS_HANDLE_ENTRY entry;
    FILE_ID_INFO identity;
    DWORD index, flags;
    uint64_t value;
    ZeroMemory(&entry, sizeof(entry));
    error = PssWalkSnapshot(snapshot, PSS_WALK_HANDLES, marker, &entry, (DWORD)sizeof(entry));
    if (error == ERROR_NO_MORE_ITEMS) { error = ERROR_SUCCESS; break; }
    if (error != ERROR_SUCCESS) break;
    if (++*visited > 16384) { error = ERROR_BUFFER_OVERFLOW; break; }
    if (GetFileType(entry.Handle) != FILE_TYPE_DISK) continue;
    ZeroMemory(&identity, sizeof(identity));
    if (!GetFileInformationByHandleEx(entry.Handle, FileIdInfo, &identity, (DWORD)sizeof(identity))) continue;
    for (index = 0; index < identityCount; index++) {
      if (memcmp(identities + (size_t)index * 24, &identity, 24) == 0) break;
    }
    if (index == identityCount) continue;
    if (*records == capacity) { error = ERROR_INSUFFICIENT_BUFFER; break; }
    if (!GetHandleInformation(entry.Handle, &flags)) { error = GetLastError(); break; }
    /* Fixed 40-byte wire record: HANDLE, full FILE_ID_INFO, flags, zero padding. */
    value = (uint64_t)(uintptr_t)entry.Handle;
    memcpy(output + (size_t)*records * 40, &value, 8);
    memcpy(output + (size_t)*records * 40 + 8, &identity, 24);
    memcpy(output + (size_t)*records * 40 + 32, &flags, 4);
    ZeroMemory(output + (size_t)*records * 40 + 36, 4);
    (*records)++;
  }
done:
  if (marker != NULL) {
    cleanup = PssWalkMarkerFree(marker);
    if (error == ERROR_SUCCESS) error = cleanup;
  }
  cleanup = PssFreeSnapshot(GetCurrentProcess(), snapshot);
  if (error == ERROR_SUCCESS) error = cleanup;
  return error;
}

__declspec(dllexport) DWORD WINAPI dsh_open_inheritable_control(const wchar_t *path, uint64_t *output) {
  SECURITY_ATTRIBUTES attributes = { (DWORD)sizeof(attributes), NULL, TRUE };
  HANDLE handle;
  if (!path || !output) return ERROR_INVALID_PARAMETER;
  *output = 0;
  handle = CreateFileW(path, FILE_READ_ATTRIBUTES | SYNCHRONIZE,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, &attributes, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (handle == INVALID_HANDLE_VALUE) return GetLastError();
  *output = (uint64_t)(uintptr_t)handle;
  return ERROR_SUCCESS;
}

__declspec(dllexport) DWORD WINAPI dsh_close_control(uint64_t *slot) {
  if (!slot || !*slot) return ERROR_INVALID_PARAMETER;
  if (!CloseHandle((HANDLE)(uintptr_t)*slot)) return GetLastError();
  *slot = 0;
  return ERROR_SUCCESS;
}

/* A retained handle is returned on uncertain teardown; callers must withhold cleanup. */
__declspec(dllexport) DWORD WINAPI dsh_stop_child(uint64_t *slot, DWORD timeout, DWORD *stopped) {
  HANDLE process;
  DWORD result, error = ERROR_SUCCESS;
  if (!slot || !stopped || timeout == 0 || timeout > 30000) return ERROR_INVALID_PARAMETER;
  *stopped = 0;
  if (!*slot) { *stopped = 1; return ERROR_SUCCESS; }
  process = (HANDLE)(uintptr_t)*slot;
  result = WaitForSingleObject(process, 0);
  if (result != WAIT_OBJECT_0) {
    if (!TerminateProcess(process, 143)) error = GetLastError();
    result = WaitForSingleObject(process, timeout);
  }
  if (result != WAIT_OBJECT_0) return error ? error : (result == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT);
  *stopped = 1;
  if (!CloseHandle(process)) return GetLastError();
  *slot = 0;
  return ERROR_SUCCESS;
}

static BOOL command_path(const wchar_t *path) {
  size_t length;
  if (!path || !(length = wcslen(path)) || length > 10000) return FALSE;
  /* Windows file names cannot contain quotes; these arguments all name files. */
  return !wcschr(path, L'"') && path[length - 1] != L'\\';
}

__declspec(dllexport) DWORD WINAPI dsh_launch_inheritance(
  const wchar_t *child, const wchar_t *specification, const wchar_t *report,
  DWORD timeout, DWORD *exitCode, DWORD *timedOut, DWORD *stopped, uint64_t *retained) {
  STARTUPINFOW startup;
  PROCESS_INFORMATION process;
  wchar_t command[32768];
  DWORD wait, error = ERROR_SUCCESS;
  if (!exitCode || !timedOut || !stopped || !retained || !command_path(child)
    || !command_path(specification) || !command_path(report) || timeout == 0 || timeout > 30000) return ERROR_INVALID_PARAMETER;
  *exitCode = STILL_ACTIVE; *timedOut = 0; *stopped = 1; *retained = 0;
  if (_snwprintf_s(command, 32768, _TRUNCATE, L"\"%ls\" \"%ls\" \"%ls\"", child, specification, report) < 0) return ERROR_BUFFER_OVERFLOW;
  ZeroMemory(&startup, sizeof(startup)); startup.cb = (DWORD)sizeof(startup);
  ZeroMemory(&process, sizeof(process));
  if (!CreateProcessW(child, command, NULL, NULL, TRUE, CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW,
    NULL, NULL, &startup, &process)) return GetLastError();
  *stopped = 0;
  *retained = (uint64_t)(uintptr_t)process.hProcess;
  if (!CloseHandle(process.hThread)) error = GetLastError();
  wait = WaitForSingleObject(process.hProcess, timeout);
  if (wait == WAIT_OBJECT_0) {
    *stopped = 1;
    if (!GetExitCodeProcess(process.hProcess, exitCode) && !error) error = GetLastError();
    if (!CloseHandle(process.hProcess)) { if (!error) error = GetLastError(); }
    else *retained = 0;
    return error;
  }
  *timedOut = wait == WAIT_TIMEOUT;
  if (!error) error = wait == WAIT_FAILED ? GetLastError() : ERROR_TIMEOUT;
  {
    DWORD cleanup = dsh_stop_child(retained, 5000, stopped);
    if (cleanup && !error) error = cleanup;
  }
  return error;
}

#else

static BOOL hex_byte(char high, char low, BYTE *output) {
  const char *digits = "0123456789abcdef";
  const char *a = strchr(digits, high), *b = strchr(digits, low);
  if (!high || !low || !a || !b) return FALSE;
  *output = (BYTE)(((a - digits) << 4) | (b - digits));
  return TRUE;
}

int wmain(int argc, wchar_t **argv) {
  FILE *input = NULL, *output = NULL;
  char line[256], handleText[17], volumeText[17], identityText[33], extra;
  unsigned count = 0, matches = 0, invalid = 0;
  BOOL malformed = FALSE;
  if (argc != 3 || _wfopen_s(&input, argv[1], L"rb") || !input) return 2;
  if (!fgets(line, sizeof(line), input) || strcmp(line, "DSH-INHERITANCE-v1\n") != 0) { fclose(input); return 3; }
  while (fgets(line, sizeof(line), input)) {
    FILE_ID_INFO actual;
    BYTE expected[16];
    uint64_t handle, volume;
    char *end;
    unsigned index;
    if (++count > 4096 || sscanf(line, "%16s %16s %32s %c", handleText, volumeText, identityText, &extra) != 3
      || strlen(handleText) != 16 || strlen(volumeText) != 16 || strlen(identityText) != 32) { malformed = TRUE; break; }
    handle = _strtoui64(handleText, &end, 16);
    if (*end || !handle) { malformed = TRUE; break; }
    volume = _strtoui64(volumeText, &end, 16);
    if (*end) { malformed = TRUE; break; }
    for (index = 0; index < 16; index++) if (!hex_byte(identityText[index * 2], identityText[index * 2 + 1], &expected[index])) { malformed = TRUE; break; }
    if (malformed) break;
    ZeroMemory(&actual, sizeof(actual));
    if (!GetFileInformationByHandleEx((HANDLE)(uintptr_t)handle, FileIdInfo, &actual, (DWORD)sizeof(actual))) { invalid++; continue; }
    if (actual.VolumeSerialNumber == volume && memcmp(actual.FileId.Identifier, expected, sizeof(expected)) == 0) matches++;
  }
  if (ferror(input)) malformed = TRUE;
  fclose(input);
  if (malformed || count == 0) return 4;
  /* The parent supplies a unique synthetic result path, never an installed path. */
  if (_wfopen_s(&output, argv[2], L"wbx") || !output) return 5;
  fprintf(output, "{\"complete\":true,\"sdkChild\":true,\"records\":%u,\"matchingInheritedIdentities\":%u,\"invalidOrNonFileHandles\":%u}\n", count, matches, invalid);
  if (fclose(output)) return 6;
  return 0;
}
#endif
