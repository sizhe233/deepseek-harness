/* Test-only Windows SDK oracle. Mutations are confined to new caller-owned fixtures.
 * cl /std:c17 /W4 /WX windows-admission-oracle.c /link Advapi32.lib
 * No WDK, privilege adjustment, account provisioning or volume configuration. */
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0A00
#endif
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <winioctl.h>
#include <stdio.h>
#include <stdlib.h>
#include <stddef.h>
#include <string.h>
#include <wchar.h>

typedef NTSTATUS (NTAPI *SetSecurityFn)(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR);
typedef NTSTATUS (NTAPI *SetFileFn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef NTSTATUS (NTAPI *QueryFileFn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, FILE_INFORMATION_CLASS);
typedef NTSTATUS (NTAPI *CreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK,
  PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef struct {
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
  TOKEN_USER *user;
  PACL acl;
} PRIVATE_SECURITY;
typedef struct {
  FILE_ID_INFO id;
  FILE_STANDARD_INFO standard;
  FILE_ATTRIBUTE_TAG_INFO tag;
  PSECURITY_DESCRIPTOR descriptor;
  DWORD descriptorBytes;
} FACTS;
static const GUID fixtureReparseGuid = {0x4e65b2a1, 0x7c39, 0x4d0e, {0xb3, 0x74, 0x1e, 0x63, 0xc8, 0x7d, 0xa2, 0x90}};

static const char *boolean(BOOL value) { return value ? "true" : "false"; }
static void hex(const void *data, size_t length) {
  const BYTE *bytes = (const BYTE *)data;
  size_t i;
  putchar('"');
  for (i = 0; i < length; ++i) printf("%02x", (unsigned)bytes[i]);
  putchar('"');
}
static void text(const wchar_t *value) {
  putchar('"');
  for (; *value; ++value) printf("\\u%04x", (unsigned)(USHORT)*value);
  putchar('"');
}
static int failure(const char *operation, DWORD error, BOOL blocked) {
  printf("{\"complete\":false,\"status\":\"%s\",\"operation\":\"%s\",\"win32Error\":%lu,\"privilegesEnabled\":false}\n",
    blocked ? "blocked" : "failed", operation, (unsigned long)error);
  return blocked ? 3 : 1;
}
static BOOL setup_unavailable(DWORD error) {
  return error == ERROR_ACCESS_DENIED || error == ERROR_PRIVILEGE_NOT_HELD ||
    error == ERROR_NOT_SUPPORTED || error == ERROR_INVALID_FUNCTION || error == ERROR_CALL_NOT_IMPLEMENTED;
}
static FARPROC native_proc(const char *name) {
  HMODULE module = GetModuleHandleW(L"ntdll.dll");
  return module ? GetProcAddress(module, name) : NULL;
}
/* memcpy avoids /W4 function-pointer conversion warnings without disabling them. */
static BOOL load_native(void *destination, size_t bytes, const char *name) {
  FARPROC address = native_proc(name);
  if (!address || bytes != sizeof(address)) return FALSE;
  memcpy(destination, &address, bytes);
  return TRUE;
}
static NTSTATUS completed(NTSTATUS status, HANDLE handle, IO_STATUS_BLOCK *iosb) {
  if (status != 259) return status;
  /* Do not release buffers still owned by pending I/O, even on a broken provider. */
  if (!handle || handle == INVALID_HANDLE_VALUE || WaitForSingleObject(handle, 30000) != WAIT_OBJECT_0) ExitProcess(87);
  if (iosb->Status == 259) ExitProcess(87);
  return iosb->Status;
}
static void *token_info(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  void *buffer;
  GetTokenInformation(token, kind, NULL, 0, &bytes);
  if (!bytes || bytes > 1024 * 1024) return NULL;
  buffer = calloc(1, bytes);
  if (!buffer) { SetLastError(ERROR_OUTOFMEMORY); return NULL; }
  if (!GetTokenInformation(token, kind, buffer, bytes, &bytes)) {
    DWORD error = GetLastError(); free(buffer); SetLastError(error); return NULL;
  }
  return buffer;
}
static BOOL security_init(PRIVATE_SECURITY *security, BOOL directory) {
  HANDLE token;
  DWORD bytes, error;
  ZeroMemory(security, sizeof(*security));
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return FALSE;
  security->user = (TOKEN_USER *)token_info(token, TokenUser);
  error = GetLastError(); CloseHandle(token);
  if (!security->user) { SetLastError(error); return FALSE; }
  bytes = (DWORD)(sizeof(ACL) + offsetof(ACCESS_ALLOWED_ACE, SidStart)) + GetLengthSid(security->user->User.Sid);
  security->acl = (PACL)calloc(1, bytes);
  if (!security->acl) { SetLastError(ERROR_OUTOFMEMORY); return FALSE; }
  if (!InitializeAcl(security->acl, bytes, ACL_REVISION) ||
      !AddAccessAllowedAceEx(security->acl, ACL_REVISION, directory ? 3 : 0, FILE_ALL_ACCESS, security->user->User.Sid) ||
      !InitializeSecurityDescriptor(&security->descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&security->descriptor, security->user->User.Sid, FALSE) ||
      !SetSecurityDescriptorDacl(&security->descriptor, TRUE, security->acl, FALSE) ||
      !SetSecurityDescriptorControl(&security->descriptor, SE_DACL_PROTECTED, SE_DACL_PROTECTED)) return FALSE;
  security->attributes.nLength = sizeof(security->attributes);
  security->attributes.lpSecurityDescriptor = &security->descriptor;
  security->attributes.bInheritHandle = FALSE;
  return TRUE;
}
static void security_free(PRIVATE_SECURITY *security) { free(security->acl); free(security->user); }
static HANDLE create_new(const wchar_t *path, BOOL directory, SECURITY_ATTRIBUTES *security) {
  if (directory && !CreateDirectoryW(path, security)) return INVALID_HANDLE_VALUE;
  return CreateFileW(path, FILE_ALL_ACCESS, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    security, directory ? OPEN_EXISTING : CREATE_NEW,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_POSIX_SEMANTICS, NULL);
}
static BOOL read_facts(HANDLE file, FACTS *facts) {
  DWORD error;
  ZeroMemory(facts, sizeof(*facts));
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &facts->id, sizeof(facts->id)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &facts->standard, sizeof(facts->standard)) ||
      !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &facts->tag, sizeof(facts->tag))) return FALSE;
  error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    NULL, NULL, NULL, NULL, &facts->descriptor);
  if (error) { SetLastError(error); return FALSE; }
  facts->descriptorBytes = GetSecurityDescriptorLength(facts->descriptor);
  return TRUE;
}
static BOOL path_facts(const wchar_t *path, FACTS *facts) {
  HANDLE file = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, NULL, OPEN_EXISTING,
    FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_POSIX_SEMANTICS, NULL);
  BOOL result;
  DWORD error;
  if (file == INVALID_HANDLE_VALUE) return FALSE;
  result = read_facts(file, facts); error = GetLastError(); CloseHandle(file); SetLastError(error);
  return result;
}
static void facts_json(const FACTS *facts) {
  PACL acl = NULL;
  BOOL present = FALSE, defaulted = FALSE;
  DWORD i;
  printf("{\"identity\":{\"volumeSerial\":\"%016llx\",\"fileId\":", (unsigned long long)facts->id.VolumeSerialNumber);
  hex(facts->id.FileId.Identifier, sizeof(facts->id.FileId.Identifier));
  printf("},\"descriptorHex\":"); hex(facts->descriptor, facts->descriptorBytes);
  printf(",\"directory\":%s,\"links\":%lu,\"sizeBytes\":\"%lld\",\"attributes\":%lu,\"reparseTag\":%lu,\"aces\":[",
    boolean(facts->standard.Directory), (unsigned long)facts->standard.NumberOfLinks,
    (long long)facts->standard.EndOfFile.QuadPart, (unsigned long)facts->tag.FileAttributes, (unsigned long)facts->tag.ReparseTag);
  if (GetSecurityDescriptorDacl(facts->descriptor, &present, &acl, &defaulted) && present && acl) {
    for (i = 0; i < acl->AceCount; ++i) {
      ACE_HEADER *ace = NULL;
      if (!GetAce(acl, i, (void **)&ace)) break;
      printf("%s{\"type\":%u,\"bytes\":%u,\"rawHex\":", i ? "," : "", (unsigned)ace->AceType, (unsigned)ace->AceSize);
      hex(ace, ace->AceSize); putchar('}');
    }
  }
  printf("]}");
}
static int inspect(const wchar_t *path) {
  FACTS facts;
  if (!path_facts(path, &facts)) return failure("inspect", GetLastError(), FALSE);
  printf("{\"complete\":true,\"facts\":"); facts_json(&facts); printf("}\n");
  LocalFree(facts.descriptor); return 0;
}
static int bootstrap(const wchar_t *path) {
  wchar_t name[] = L"\\??\\C:\\";
  UNICODE_STRING unicode;
  OBJECT_ATTRIBUTES attributes;
  IO_STATUS_BLOCK iosb;
  HANDLE handle = NULL;
  CreateFileFn createFile = NULL;
  NTSTATUS initial, status;
  if (wcslen(path) < 3 || path[1] != L':' || path[2] != L'\\') return failure("bootstrap-drive-path", ERROR_INVALID_NAME, FALSE);
  if (!load_native(&createFile, sizeof(createFile), "NtCreateFile")) return failure("bootstrap-NtCreateFile", ERROR_NOT_SUPPORTED, TRUE);
  name[4] = path[0];
  unicode.Length = (USHORT)(wcslen(name) * sizeof(wchar_t)); unicode.MaximumLength = sizeof(name); unicode.Buffer = name;
  ZeroMemory(&attributes, sizeof(attributes)); ZeroMemory(&iosb, sizeof(iosb));
  attributes.Length = sizeof(attributes); attributes.ObjectName = &unicode; attributes.Attributes = 0x1040;
  /* Exact product root directory open: READ_CONTROL|SYNCHRONIZE|READ_ATTRIBUTES|LIST|TRAVERSE. */
  initial = createFile(&handle, 0x1200A1, &attributes, &iosb, NULL, 0x80, 3, 1, 0x200021, NULL, 0);
  status = completed(initial, handle, &iosb);
  printf("{\"complete\":true,\"diagnosticOnly\":true,\"name\":"); text(name);
  printf(",\"objectAttributes\":4160,\"desiredAccess\":1179809,\"shareAccess\":3,\"createOptions\":2097185,\"initialStatus\":%ld,\"nativeStatus\":%ld,\"opened\":%s}\n",
    (long)initial, (long)status, boolean(status >= 0 && handle && handle != INVALID_HANDLE_VALUE));
  if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
  return 0;
}
static int inventory(void) {
  HANDLE token, thread = NULL;
  TOKEN_PRIVILEGES *privileges;
  TOKEN_ELEVATION elevation;
  DWORD bytes, i, needed, copied, threadError, previousErrorMode = 0;
  wchar_t *drives, *drive;
  BOOL first = TRUE, threadPresent, errorModeChanged;
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return failure("inventory-token", GetLastError(), FALSE);
  privileges = (TOKEN_PRIVILEGES *)token_info(token, TokenPrivileges);
  if (!privileges) { DWORD error = GetLastError(); CloseHandle(token); return failure("inventory-privileges", error, FALSE); }
  if (!GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes)) {
    DWORD error = GetLastError(); free(privileges); CloseHandle(token); return failure("inventory-elevation", error, FALSE);
  }
  threadPresent = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread);
  threadError = threadPresent ? ERROR_SUCCESS : GetLastError();
  if (threadPresent) CloseHandle(thread);
  needed = GetLogicalDriveStringsW(0, NULL);
  if (!needed || needed > 32768) { free(privileges); CloseHandle(token); return failure("inventory-drives", ERROR_INVALID_DATA, FALSE); }
  drives = (wchar_t *)calloc((size_t)needed + 1, sizeof(wchar_t));
  if (!drives) { free(privileges); CloseHandle(token); return failure("inventory-memory", ERROR_OUTOFMEMORY, FALSE); }
  copied = GetLogicalDriveStringsW(needed + 1, drives);
  if (!copied || copied >= needed + 1) {
    DWORD error = copied ? ERROR_INSUFFICIENT_BUFFER : GetLastError();
    free(drives); free(privileges); CloseHandle(token); return failure("inventory-drives", error, FALSE);
  }
  printf("{\"complete\":true,\"readOnly\":true,\"inventoryScope\":\"mounted-drive-letters\",\"privilegesEnabled\":false,\"elevated\":%s,\"restricted\":%s,\"threadTokenPresent\":%s,\"threadTokenError\":%lu,\"privileges\":[",
    boolean(elevation.TokenIsElevated), boolean(IsTokenRestricted(token)), boolean(threadPresent), (unsigned long)threadError);
  for (i = 0; i < privileges->PrivilegeCount; ++i) {
    wchar_t name[256]; DWORD length = 256;
    BOOL named = LookupPrivilegeNameW(NULL, &privileges->Privileges[i].Luid, name, &length);
    printf("%s{\"name\":", i ? "," : ""); if (named) text(name); else printf("null");
    printf(",\"attributes\":%lu,\"enabled\":%s}", (unsigned long)privileges->Privileges[i].Attributes,
      boolean(privileges->Privileges[i].Attributes & SE_PRIVILEGE_ENABLED));
  }
  /* Suppress media-error UI on this thread only; no machine or drive setting changes. */
  errorModeChanged = SetThreadErrorMode(SEM_FAILCRITICALERRORS, &previousErrorMode);
  printf("],\"volumes\":[");
  for (drive = drives; *drive; drive += wcslen(drive) + 1) {
    wchar_t filesystem[128] = {0};
    DWORD flags = 0, component = 0, serial = 0, error = ERROR_SUCCESS;
    ULARGE_INTEGER freeBytes = {0}, total = {0}, totalFree = {0};
    UINT type = GetDriveTypeW(drive);
    BOOL metadataAttempted = type == DRIVE_FIXED || type == DRIVE_REMOVABLE || type == DRIVE_CDROM || type == DRIVE_RAMDISK;
    BOOL available = FALSE;
    /* Do not resolve remote/unknown mappings or initiate network authentication. */
    if (metadataAttempted) {
      available = GetVolumeInformationW(drive, NULL, 0, &serial, &component, &flags, filesystem, 128);
      if (!available) error = GetLastError();
    }
    printf("%s{\"root\":", first ? "" : ","); text(drive); first = FALSE;
    printf(",\"driveType\":%u,\"metadataAttempted\":%s,\"metadataAvailable\":%s,\"win32Error\":%lu,\"filesystem\":",
      (unsigned)type, boolean(metadataAttempted), boolean(available), (unsigned long)error);
    text(filesystem);
    printf(",\"flags\":%lu,\"readOnly\":%s,\"persistentAcls\":%s,\"reparsePoints\":%s,\"remote\":%s",
      (unsigned long)flags, boolean(flags & FILE_READ_ONLY_VOLUME), boolean(flags & FILE_PERSISTENT_ACLS),
      boolean(flags & FILE_SUPPORTS_REPARSE_POINTS), boolean(type == DRIVE_REMOTE));
    if (metadataAttempted) {
      if (GetDiskFreeSpaceExW(drive, &freeBytes, &total, &totalFree))
        printf(",\"availableBytes\":\"%llu\",\"totalBytes\":\"%llu\"", (unsigned long long)freeBytes.QuadPart, (unsigned long long)total.QuadPart);
      else printf(",\"freeSpaceError\":%lu", (unsigned long)GetLastError());
    } else printf(",\"metadataSkipped\":\"remote-or-unknown-drive\"");
    putchar('}');
  }
  if (errorModeChanged) SetThreadErrorMode(previousErrorMode, NULL);
  printf("]}\n"); free(drives); free(privileges); CloseHandle(token); return 0;
}
static int conditional(const wchar_t *path) {
  PRIVATE_SECURITY security;
  LPWSTR sid = NULL;
  wchar_t sddl[1024];
  PSECURITY_DESCRIPTOR descriptor = NULL;
  SECURITY_ATTRIBUTES attributes;
  HANDLE file;
  DWORD error;
  FACTS facts;
  if (!security_init(&security, FALSE)) { error = GetLastError(); security_free(&security); return failure("conditional-security", error, FALSE); }
  if (!ConvertSidToStringSidW(security.user->User.Sid, &sid)) { error = GetLastError(); security_free(&security); return failure("conditional-sid", error, FALSE); }
  if (swprintf_s(sddl, 1024, L"O:%lsD:P(A;;FA;;;%ls)(XA;;FR;;;WD;(Member_of {SID(S-1-1-0)}))", sid, sid) < 0) {
    LocalFree(sid); security_free(&security); return failure("conditional-sddl-length", ERROR_INVALID_DATA, FALSE);
  }
  LocalFree(sid); security_free(&security);
  if (!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl, SDDL_REVISION_1, &descriptor, NULL))
    return failure("conditional-sddl", GetLastError(), FALSE);
  attributes.nLength = sizeof(attributes); attributes.lpSecurityDescriptor = descriptor; attributes.bInheritHandle = FALSE;
  file = create_new(path, FALSE, &attributes); error = GetLastError(); LocalFree(descriptor);
  if (file == INVALID_HANDLE_VALUE) return failure("conditional-create", error, setup_unavailable(error));
  CloseHandle(file);
  if (!path_facts(path, &facts)) return failure("conditional-readback", GetLastError(), FALSE);
  printf("{\"complete\":true,\"condition\":\"Member_of {SID(S-1-1-0)}\",\"facts\":"); facts_json(&facts); printf("}\n");
  LocalFree(facts.descriptor); return 0;
}
static int malformed(const wchar_t *path) {
  PRIVATE_SECURITY security;
  HANDLE file;
  FACTS before, after;
  SetSecurityFn setSecurity = NULL;
  NTSTATUS aclStatus, revisionStatus;
  DWORD error;
  BOOL unchanged;
  if (!load_native(&setSecurity, sizeof(setSecurity), "NtSetSecurityObject")) return failure("NtSetSecurityObject", ERROR_NOT_SUPPORTED, TRUE);
  if (!security_init(&security, FALSE)) { error = GetLastError(); security_free(&security); return failure("malformed-security", error, FALSE); }
  file = create_new(path, FALSE, &security.attributes);
  if (file == INVALID_HANDLE_VALUE) { error = GetLastError(); security_free(&security); return failure("malformed-create", error, setup_unavailable(error)); }
  if (!path_facts(path, &before)) { error = GetLastError(); CloseHandle(file); security_free(&security); return failure("malformed-before", error, FALSE); }
  /* Only revision bytes change; all pointers and length fields still address allocated valid storage. */
  security.acl->AclRevision = 0;
  aclStatus = setSecurity(file, DACL_SECURITY_INFORMATION, &security.descriptor);
  security.acl->AclRevision = ACL_REVISION;
  security.descriptor.Revision = 0;
  revisionStatus = setSecurity(file, DACL_SECURITY_INFORMATION, &security.descriptor);
  security.descriptor.Revision = SECURITY_DESCRIPTOR_REVISION;
  CloseHandle(file); security_free(&security);
  if (!path_facts(path, &after)) { error = GetLastError(); LocalFree(before.descriptor); return failure("malformed-after", error, FALSE); }
  unchanged = before.descriptorBytes == after.descriptorBytes &&
    memcmp(before.descriptor, after.descriptor, before.descriptorBytes) == 0 && memcmp(&before.id, &after.id, sizeof(before.id)) == 0;
  printf("{\"complete\":true,\"submission\":\"NtSetSecurityObject\",\"aclRevisionStatus\":%ld,\"descriptorRevisionStatus\":%ld,\"unchanged\":%s,\"before\":",
    (long)aclStatus, (long)revisionStatus, boolean(unchanged)); facts_json(&before); printf(",\"after\":"); facts_json(&after); printf("}\n");
  LocalFree(before.descriptor); LocalFree(after.descriptor); return 0;
}
static int short_name(const wchar_t *path) {
  wchar_t alias[32768];
  DWORD length = GetShortPathNameW(path, alias, 32768);
  const wchar_t *leaf = wcsrchr(path, L'\\'), *shortLeaf;
  FACTS original, shortened;
  if (!length) { DWORD error = GetLastError(); return failure("GetShortPathNameW", error, setup_unavailable(error)); }
  if (length >= 32768) return failure("short-name-length", ERROR_INSUFFICIENT_BUFFER, FALSE);
  shortLeaf = wcsrchr(alias, L'\\');
  if (!leaf || !shortLeaf) return failure("short-name-component", ERROR_INVALID_NAME, FALSE);
  if (wcscmp(leaf + 1, shortLeaf + 1) == 0) return failure("no-existing-short-alias", ERROR_NOT_FOUND, TRUE);
  if (!path_facts(path, &original)) return failure("short-name-original", GetLastError(), FALSE);
  if (!path_facts(alias, &shortened)) { DWORD error = GetLastError(); LocalFree(original.descriptor); return failure("short-name-alias", error, FALSE); }
  printf("{\"complete\":true,\"alias\":"); text(shortLeaf + 1);
  printf(",\"original\":"); facts_json(&original); printf(",\"aliased\":"); facts_json(&shortened); printf("}\n");
  LocalFree(original.descriptor); LocalFree(shortened.descriptor); return 0;
}
static int case_sensitive(const wchar_t *path) {
  PRIVATE_SECURITY security;
  HANDLE directory, lower = INVALID_HANDLE_VALUE, upper = INVALID_HANDLE_VALUE;
  SetFileFn setFile = NULL; QueryFileFn queryFile = NULL;
  IO_STATUS_BLOCK iosb;
  ULONG flags = 1, observed = 0;
  NTSTATUS status, queryStatus;
  wchar_t name[32768];
  FILE_ID_INFO lowerId, upperId;
  DWORD error;
  if (!load_native(&setFile, sizeof(setFile), "NtSetInformationFile") || !load_native(&queryFile, sizeof(queryFile), "NtQueryInformationFile"))
    return failure("case-sensitive-native-functions", ERROR_NOT_SUPPORTED, TRUE);
  if (!security_init(&security, TRUE)) { error = GetLastError(); security_free(&security); return failure("case-sensitive-security", error, FALSE); }
  directory = create_new(path, TRUE, &security.attributes);
  if (directory == INVALID_HANDLE_VALUE) { error = GetLastError(); security_free(&security); return failure("case-sensitive-create", error, setup_unavailable(error)); }
  ZeroMemory(&iosb, sizeof(iosb));
  status = completed(setFile(directory, &iosb, &flags, sizeof(flags), (FILE_INFORMATION_CLASS)71), directory, &iosb);
  if (status < 0) {
    ULONG code = (ULONG)status;
    BOOL unavailable = code == 0xC0000061UL || code == 0xC0000022UL || code == 0xC0000003UL ||
      code == 0xC000000DUL || code == 0xC00000BBUL || code == 0xC0000002UL;
    CloseHandle(directory); security_free(&security);
    printf("{\"complete\":false,\"status\":\"%s\",\"operation\":\"set-case-sensitive\",\"nativeStatus\":%ld,\"privilegesEnabled\":false}\n",
      unavailable ? "blocked" : "failed", (long)status); return unavailable ? 3 : 1;
  }
  ZeroMemory(&iosb, sizeof(iosb)); queryStatus = completed(queryFile(directory, &iosb, &observed, sizeof(observed), (FILE_INFORMATION_CLASS)71), directory, &iosb);
  if (queryStatus < 0 || observed != 1 || iosb.Information != sizeof(observed)) {
    CloseHandle(directory); security_free(&security); return failure("case-sensitive-readback", ERROR_INVALID_DATA, FALSE);
  }
  security_free(&security);
  if (!security_init(&security, FALSE)) { error = GetLastError(); security_free(&security); CloseHandle(directory); return failure("case-sensitive-file-security", error, FALSE); }
  if (swprintf_s(name, 32768, L"%ls\\case", path) >= 0) lower = create_new(name, FALSE, &security.attributes);
  error = GetLastError();
  if (lower != INVALID_HANDLE_VALUE && swprintf_s(name, 32768, L"%ls\\Case", path) >= 0) { upper = create_new(name, FALSE, &security.attributes); error = GetLastError(); }
  security_free(&security); CloseHandle(directory);
  if (lower == INVALID_HANDLE_VALUE || upper == INVALID_HANDLE_VALUE) {
    if (lower != INVALID_HANDLE_VALUE) CloseHandle(lower); if (upper != INVALID_HANDLE_VALUE) CloseHandle(upper);
    return failure("case-sensitive-distinct-files", error, FALSE);
  }
  if (!GetFileInformationByHandleEx(lower, FileIdInfo, &lowerId, sizeof(lowerId)) || !GetFileInformationByHandleEx(upper, FileIdInfo, &upperId, sizeof(upperId))) {
    error = GetLastError(); CloseHandle(lower); CloseHandle(upper); return failure("case-sensitive-identities", error, FALSE);
  }
  CloseHandle(lower); CloseHandle(upper);
  printf("{\"complete\":true,\"flags\":%lu,\"setStatus\":%ld,\"queryStatus\":%ld,\"distinctFileIds\":%s,\"privilegesEnabled\":false}\n",
    (unsigned long)observed, (long)status, (long)queryStatus, boolean(memcmp(&lowerId, &upperId, sizeof(lowerId)) != 0)); return 0;
}
/* Reparse buffers use documented wire offsets; user-mode SDK lacks REPARSE_DATA_BUFFER in some releases. */
static int reparse(const wchar_t *path, const wchar_t *target, BOOL junction) {
  PRIVATE_SECURITY security;
  HANDLE directory;
  BYTE buffer[MAXIMUM_REPARSE_DATA_BUFFER_SIZE] = {0}, readback[MAXIMUM_REPARSE_DATA_BUFFER_SIZE] = {0};
  wchar_t substitute[4096];
  DWORD bytes, returned, error, tag = junction ? IO_REPARSE_TAG_MOUNT_POINT : 0x00000042UL;
  USHORT dataBytes;
  BOOL result;
  FACTS facts;
  if (!security_init(&security, TRUE)) { error = GetLastError(); security_free(&security); return failure("reparse-security", error, FALSE); }
  directory = create_new(path, TRUE, &security.attributes); error = GetLastError(); security_free(&security);
  if (directory == INVALID_HANDLE_VALUE) return failure("reparse-create", error, setup_unavailable(error));
  memcpy(buffer, &tag, sizeof(tag));
  if (junction) {
    USHORT substituteBytes, printOffset, printBytes;
    size_t length;
    if (swprintf_s(substitute, 4096, L"\\??\\%ls", target) < 0) { CloseHandle(directory); return failure("junction-target-length", ERROR_INVALID_NAME, FALSE); }
    length = wcslen(substitute); substituteBytes = (USHORT)(length * sizeof(wchar_t));
    printOffset = (USHORT)(substituteBytes + sizeof(wchar_t)); printBytes = (USHORT)(wcslen(target) * sizeof(wchar_t));
    bytes = 16UL + printOffset + printBytes + (DWORD)sizeof(wchar_t);
    if (bytes > sizeof(buffer)) { CloseHandle(directory); return failure("junction-buffer", ERROR_INSUFFICIENT_BUFFER, FALSE); }
    dataBytes = (USHORT)(bytes - 8); memcpy(buffer + 4, &dataBytes, sizeof(dataBytes));
    memcpy(buffer + 10, &substituteBytes, sizeof(substituteBytes)); memcpy(buffer + 12, &printOffset, sizeof(printOffset));
    memcpy(buffer + 14, &printBytes, sizeof(printBytes)); memcpy(buffer + 16, substitute, substituteBytes);
    memcpy(buffer + 16 + printOffset, target, printBytes);
  } else {
    /* An unregistered non-Microsoft tag with a fixture-specific GUID and opaque payload. */
    const BYTE payload[4] = {'t', 'e', 's', 't'};
    dataBytes = sizeof(payload); bytes = 24UL + (DWORD)sizeof(payload);
    memcpy(buffer + 4, &dataBytes, sizeof(dataBytes)); memcpy(buffer + 8, &fixtureReparseGuid, sizeof(fixtureReparseGuid)); memcpy(buffer + 24, payload, sizeof(payload));
  }
  result = DeviceIoControl(directory, FSCTL_SET_REPARSE_POINT, buffer, bytes, NULL, 0, &returned, NULL); error = GetLastError();
  if (!result) { CloseHandle(directory); return failure(junction ? "set-junction" : "set-unknown-reparse", error, setup_unavailable(error)); }
  result = DeviceIoControl(directory, FSCTL_GET_REPARSE_POINT, NULL, 0, readback, sizeof(readback), &returned, NULL); error = GetLastError(); CloseHandle(directory);
  if (!result) return failure("readback-reparse", error, FALSE);
  if (returned != bytes || memcmp(buffer, readback, bytes) != 0) return failure("reparse-data-mismatch", ERROR_INVALID_DATA, FALSE);
  if (!path_facts(path, &facts)) return failure("reparse-inspect", GetLastError(), FALSE);
  printf("{\"complete\":true,\"privilegesEnabled\":false,\"tag\":%lu,\"reparseBytes\":", (unsigned long)tag); hex(readback, returned);
  printf(",\"facts\":"); facts_json(&facts); printf("}\n"); LocalFree(facts.descriptor); return 0;
}
static int pipe_fixture(const wchar_t *path) {
  PRIVATE_SECURITY security;
  HANDLE pipe;
  DWORD error;
  char command[32];
  const wchar_t prefix[] = L"\\\\.\\pipe\\private-storage-admission-";
  if (wcsncmp(path, prefix, (sizeof(prefix) / sizeof(prefix[0])) - 1) != 0) return failure("pipe-name", ERROR_INVALID_NAME, FALSE);
  if (!security_init(&security, FALSE)) { error = GetLastError(); security_free(&security); return failure("pipe-security", error, FALSE); }
  pipe = CreateNamedPipeW(path, PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
    PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_NOWAIT | PIPE_REJECT_REMOTE_CLIENTS, 1, 256, 256, 1000, &security.attributes);
  error = GetLastError(); security_free(&security);
  if (pipe == INVALID_HANDLE_VALUE) return failure("create-named-pipe", error, setup_unavailable(error));
  printf("{\"complete\":true,\"ready\":true,\"fileType\":%lu,\"remoteClientsRejected\":true}\n", (unsigned long)GetFileType(pipe)); fflush(stdout);
  if (!fgets(command, sizeof(command), stdin) || strcmp(command, "close\n") != 0) { CloseHandle(pipe); return 1; }
  if (!CloseHandle(pipe)) return failure("close-named-pipe", GetLastError(), FALSE);
  printf("{\"complete\":true,\"closed\":true}\n"); return 0;
}
static int clear_reparse(const wchar_t *path, const wchar_t *volume, const wchar_t *fileId) {
  HANDLE file;
  FACTS facts;
  wchar_t actualVolume[17], actualId[33];
  BYTE buffer[MAXIMUM_REPARSE_DATA_BUFFER_SIZE] = {0};
  DWORD returned, bytes, tag, error, i;
  USHORT empty = 0;
  BOOL result;
  file = CreateFileW(path, FILE_ALL_ACCESS, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (file == INVALID_HANDLE_VALUE) return failure("clear-reparse-open", GetLastError(), FALSE);
  if (!read_facts(file, &facts)) { error = GetLastError(); CloseHandle(file); return failure("clear-reparse-facts", error, FALSE); }
  swprintf_s(actualVolume, 17, L"%016llx", (unsigned long long)facts.id.VolumeSerialNumber);
  for (i = 0; i < 16; ++i) swprintf_s(actualId + i * 2, 33 - i * 2, L"%02x", (unsigned)facts.id.FileId.Identifier[i]);
  LocalFree(facts.descriptor);
  if (wcscmp(volume, actualVolume) != 0 || wcscmp(fileId, actualId) != 0) { CloseHandle(file); return failure("clear-reparse-identity", ERROR_INVALID_DATA, FALSE); }
  if (!DeviceIoControl(file, FSCTL_GET_REPARSE_POINT, NULL, 0, buffer, sizeof(buffer), &returned, NULL)) {
    error = GetLastError(); CloseHandle(file); return failure("clear-reparse-readback", error, FALSE);
  }
  if (returned < 8) { CloseHandle(file); return failure("clear-reparse-header", ERROR_INVALID_DATA, FALSE); }
  memcpy(&tag, buffer, sizeof(tag));
  if (tag != IO_REPARSE_TAG_MOUNT_POINT && tag != 0x00000042UL) { CloseHandle(file); return failure("clear-reparse-tag", ERROR_INVALID_DATA, FALSE); }
  bytes = (tag & 0x80000000UL) ? 8 : 24;
  if (returned < bytes) { CloseHandle(file); return failure("clear-reparse-header", ERROR_INVALID_DATA, FALSE); }
  if (tag == 0x00000042UL && memcmp(buffer + 8, &fixtureReparseGuid, sizeof(fixtureReparseGuid)) != 0) {
    CloseHandle(file); return failure("clear-reparse-guid", ERROR_INVALID_DATA, FALSE);
  }
  memcpy(buffer + 4, &empty, sizeof(empty));
  result = DeviceIoControl(file, FSCTL_DELETE_REPARSE_POINT, buffer, bytes, NULL, 0, &returned, NULL);
  error = GetLastError(); CloseHandle(file);
  if (!result) return failure("clear-reparse-delete-tag", error, FALSE);
  printf("{\"complete\":true,\"tagCleared\":true}\n"); return 0;
}
int wmain(int argc, wchar_t **argv) {
  if (argc == 2 && wcscmp(argv[1], L"inventory") == 0) return inventory();
  if (argc == 3 && wcscmp(argv[1], L"inspect") == 0) return inspect(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"bootstrap") == 0) return bootstrap(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"conditional") == 0) return conditional(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"malformed") == 0) return malformed(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"short-name") == 0) return short_name(argv[2]);
  if (argc == 3 && wcscmp(argv[1], L"case-sensitive") == 0) return case_sensitive(argv[2]);
  if (argc == 4 && wcscmp(argv[1], L"junction") == 0) return reparse(argv[2], argv[3], TRUE);
  if (argc == 3 && wcscmp(argv[1], L"unknown-reparse") == 0) return reparse(argv[2], NULL, FALSE);
  if (argc == 3 && wcscmp(argv[1], L"pipe") == 0) return pipe_fixture(argv[2]);
  if (argc == 5 && wcscmp(argv[1], L"clear-reparse") == 0) return clear_reparse(argv[2], argv[3], argv[4]);
  return failure("arguments", ERROR_INVALID_PARAMETER, FALSE);
}
