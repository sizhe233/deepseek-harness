/* Test-only Windows SDK oracle. No WDK, runtime addon, privilege changes, or account setup. */
#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0A00
#include <windows.h>
#include <winternl.h>
#include <aclapi.h>
#include <sddl.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

/* The SDK omits the WDK FILE_MODE_INFORMATION typedef; its documented member is ULONG. */
typedef struct { ULONG Mode; } ORACLE_FILE_MODE_INFORMATION;
typedef struct { ULONG DeviceType; ULONG Characteristics; } ORACLE_FS_DEVICE_INFORMATION;
typedef NTSTATUS (NTAPI *QueryFileFn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *QueryVolumeFn)(HANDLE, PIO_STATUS_BLOCK, PVOID, ULONG, ULONG);
typedef NTSTATUS (NTAPI *VersionFn)(OSVERSIONINFOW *);
typedef NTSTATUS (NTAPI *CreateFileFn)(PHANDLE, ACCESS_MASK, POBJECT_ATTRIBUTES, PIO_STATUS_BLOCK, PLARGE_INTEGER, ULONG, ULONG, ULONG, ULONG, PVOID, ULONG);
typedef NTSTATUS (NTAPI *SetSecurityFn)(HANDLE, SECURITY_INFORMATION, PSECURITY_DESCRIPTOR);

static void hex(const void *value, size_t length) {
  const unsigned char *bytes = (const unsigned char *)value;
  size_t i;
  putchar('"');
  for (i = 0; i < length; ++i) printf("%02x", bytes[i]);
  putchar('"');
}

static const char *json_boolean(BOOL value) { return value ? "true" : "false"; }

static void json_string(const char *value) {
  const unsigned char *p = (const unsigned char *)value;
  putchar('"');
  while (*p) {
    if (*p == '"' || *p == '\\') { putchar('\\'); putchar(*p); }
    else if (*p < 32) printf("\\u%04x", *p);
    else putchar(*p);
    ++p;
  }
  putchar('"');
}

static int failure(const char *operation, DWORD error, BOOL blocked) {
  printf("{\"complete\":false,\"status\":\"%s\",\"operation\":", blocked ? "blocked" : "failed");
  json_string(operation);
  printf(",\"win32Error\":%lu}\n", (unsigned long)error);
  return blocked ? 3 : 1;
}

static BOOL unavailable(DWORD error) {
  return error == ERROR_PRIVILEGE_NOT_HELD || error == ERROR_NOT_SUPPORTED ||
    error == ERROR_INVALID_FUNCTION || error == ERROR_CALL_NOT_IMPLEMENTED;
}

static FARPROC native_proc(const char *name) {
  HMODULE dll = GetModuleHandleW(L"ntdll.dll");
  return dll ? GetProcAddress(dll, name) : NULL;
}

#define START_LAYOUT(t) printf("\"" #t "\":{\"size\":%zu,\"alignment\":%zu", sizeof(t), (size_t)__alignof(t))
#define MEMBER(t, f) printf(",\"" #f "\":%zu", offsetof(t, f))
#define END_LAYOUT() printf("},")

static int abi(void) {
  printf("{\"complete\":true,\"pointerBytes\":%zu,\"ntstatusBytes\":%zu,\"ntstatusSigned\":%s,\"structures\":{",
    sizeof(void *), sizeof(NTSTATUS), json_boolean((NTSTATUS)0xc0000022L < 0));
  START_LAYOUT(OBJECT_ATTRIBUTES); MEMBER(OBJECT_ATTRIBUTES, Length); MEMBER(OBJECT_ATTRIBUTES, RootDirectory);
  MEMBER(OBJECT_ATTRIBUTES, ObjectName); MEMBER(OBJECT_ATTRIBUTES, Attributes);
  MEMBER(OBJECT_ATTRIBUTES, SecurityDescriptor); MEMBER(OBJECT_ATTRIBUTES, SecurityQualityOfService); END_LAYOUT();
  START_LAYOUT(UNICODE_STRING); MEMBER(UNICODE_STRING, Length); MEMBER(UNICODE_STRING, MaximumLength);
  MEMBER(UNICODE_STRING, Buffer); END_LAYOUT();
  START_LAYOUT(IO_STATUS_BLOCK); MEMBER(IO_STATUS_BLOCK, Status); MEMBER(IO_STATUS_BLOCK, Pointer);
  MEMBER(IO_STATUS_BLOCK, Information); END_LAYOUT();
  START_LAYOUT(FILE_RENAME_INFO); MEMBER(FILE_RENAME_INFO, ReplaceIfExists); MEMBER(FILE_RENAME_INFO, Flags);
  MEMBER(FILE_RENAME_INFO, RootDirectory); MEMBER(FILE_RENAME_INFO, FileNameLength); MEMBER(FILE_RENAME_INFO, FileName); END_LAYOUT();
  START_LAYOUT(OVERLAPPED); MEMBER(OVERLAPPED, Internal); MEMBER(OVERLAPPED, InternalHigh);
  MEMBER(OVERLAPPED, Offset); MEMBER(OVERLAPPED, OffsetHigh); MEMBER(OVERLAPPED, hEvent); END_LAYOUT();
  START_LAYOUT(FILE_ID_INFO); MEMBER(FILE_ID_INFO, VolumeSerialNumber); MEMBER(FILE_ID_INFO, FileId); END_LAYOUT();
  START_LAYOUT(FILE_BASIC_INFO); MEMBER(FILE_BASIC_INFO, CreationTime); MEMBER(FILE_BASIC_INFO, LastAccessTime);
  MEMBER(FILE_BASIC_INFO, LastWriteTime); MEMBER(FILE_BASIC_INFO, ChangeTime); MEMBER(FILE_BASIC_INFO, FileAttributes); END_LAYOUT();
  START_LAYOUT(FILE_STANDARD_INFO); MEMBER(FILE_STANDARD_INFO, AllocationSize); MEMBER(FILE_STANDARD_INFO, EndOfFile);
  MEMBER(FILE_STANDARD_INFO, NumberOfLinks); MEMBER(FILE_STANDARD_INFO, DeletePending); MEMBER(FILE_STANDARD_INFO, Directory); END_LAYOUT();
  printf("\"FILE_MODE_INFORMATION\":{\"size\":%zu,\"alignment\":%zu,\"Mode\":%zu},",
    sizeof(ORACLE_FILE_MODE_INFORMATION), (size_t)__alignof(ORACLE_FILE_MODE_INFORMATION), offsetof(ORACLE_FILE_MODE_INFORMATION, Mode));
  START_LAYOUT(SECURITY_DESCRIPTOR); MEMBER(SECURITY_DESCRIPTOR, Revision); MEMBER(SECURITY_DESCRIPTOR, Control);
  MEMBER(SECURITY_DESCRIPTOR, Owner); MEMBER(SECURITY_DESCRIPTOR, Group); MEMBER(SECURITY_DESCRIPTOR, Sacl); MEMBER(SECURITY_DESCRIPTOR, Dacl); END_LAYOUT();
  START_LAYOUT(SECURITY_DESCRIPTOR_RELATIVE); MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Revision); MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Control);
  MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Owner); MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Group);
  MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Sacl); MEMBER(SECURITY_DESCRIPTOR_RELATIVE, Dacl); END_LAYOUT();
  START_LAYOUT(ACL); MEMBER(ACL, AclRevision); MEMBER(ACL, AclSize); MEMBER(ACL, AceCount); END_LAYOUT();
  START_LAYOUT(ACE_HEADER); MEMBER(ACE_HEADER, AceType); MEMBER(ACE_HEADER, AceFlags); MEMBER(ACE_HEADER, AceSize); END_LAYOUT();
  START_LAYOUT(ACCESS_ALLOWED_ACE); MEMBER(ACCESS_ALLOWED_ACE, Header); MEMBER(ACCESS_ALLOWED_ACE, Mask);
  MEMBER(ACCESS_ALLOWED_ACE, SidStart); END_LAYOUT();
  START_LAYOUT(SID_AND_ATTRIBUTES); MEMBER(SID_AND_ATTRIBUTES, Sid); MEMBER(SID_AND_ATTRIBUTES, Attributes); END_LAYOUT();
  START_LAYOUT(TOKEN_USER); MEMBER(TOKEN_USER, User); END_LAYOUT();
  START_LAYOUT(SID); MEMBER(SID, Revision); MEMBER(SID, SubAuthorityCount); MEMBER(SID, IdentifierAuthority); MEMBER(SID, SubAuthority);
  printf("}},\"constants\":{\"fileAllAccess\":%lu,\"objectInheritAce\":%u,\"containerInheritAce\":%u,"
    "\"daclPresent\":%u,\"daclProtected\":%u,\"selfRelative\":%u,\"statusPending\":259,"
    "\"statusAccessDeniedSigned\":%ld},\"equivalents\":{"
    "\"nativeRename\":\"SDK FILE_RENAME_INFO layout; no SetFileInformationByHandle path conversion\","
    "\"nativeBasic\":\"SDK FILE_BASIC_INFO layout\",\"nativeStandard\":\"SDK FILE_STANDARD_INFO layout\","
    "\"nativeMode\":\"documented single ULONG Mode member; WDK typedef unavailable in user-mode SDK\"}}\n",
    (unsigned long)FILE_ALL_ACCESS, (unsigned)OBJECT_INHERIT_ACE, (unsigned)CONTAINER_INHERIT_ACE,
    (unsigned)SE_DACL_PRESENT, (unsigned)SE_DACL_PROTECTED, (unsigned)SE_SELF_RELATIVE, (long)(NTSTATUS)0xc0000022L);
  return 0;
}

static void *token_information(HANDLE token, TOKEN_INFORMATION_CLASS kind) {
  DWORD bytes = 0;
  void *result;
  GetTokenInformation(token, kind, NULL, 0, &bytes);
  if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || !bytes) return NULL;
  result = calloc(1, bytes);
  if (!result) { SetLastError(ERROR_OUTOFMEMORY); return NULL; }
  if (!GetTokenInformation(token, kind, result, bytes, &bytes)) { DWORD error = GetLastError(); free(result); SetLastError(error); return NULL; }
  return result;
}

static int token_facts(void) {
  HANDLE token = NULL, thread = NULL;
  TOKEN_USER *user = NULL;
  TOKEN_OWNER *owner = NULL;
  TOKEN_ELEVATION elevation;
  TOKEN_TYPE type;
  DWORD bytes, error = ERROR_SUCCESS, threadError, handles;
  BOOL threadPresent;
  OSVERSIONINFOW version;
  VersionFn getVersion = (VersionFn)native_proc("RtlGetVersion");
  ZeroMemory(&version, sizeof(version)); version.dwOSVersionInfoSize = sizeof(version);
  if (!getVersion || getVersion(&version) < 0) return failure("RtlGetVersion", ERROR_NOT_SUPPORTED, FALSE);
  threadPresent = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread);
  threadError = threadPresent ? ERROR_SUCCESS : GetLastError();
  if (threadPresent) CloseHandle(thread);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return failure("OpenProcessToken", GetLastError(), FALSE);
  user = (TOKEN_USER *)token_information(token, TokenUser);
  if (!user) { error = GetLastError(); CloseHandle(token); return failure("TokenUser", error, FALSE); }
  owner = (TOKEN_OWNER *)token_information(token, TokenOwner);
  if (!owner) { error = GetLastError(); free(user); CloseHandle(token); return failure("TokenOwner", error, FALSE); }
  if (!GetTokenInformation(token, TokenElevation, &elevation, sizeof(elevation), &bytes) ||
      !GetTokenInformation(token, TokenType, &type, sizeof(type), &bytes) || !GetProcessHandleCount(GetCurrentProcess(), &handles)) {
    error = GetLastError(); free(user); free(owner); CloseHandle(token); return failure("token-facts", error, FALSE);
  }
  printf("{\"complete\":true,\"userSid\":"); hex(user->User.Sid, GetLengthSid(user->User.Sid));
  printf(",\"defaultOwnerSid\":"); hex(owner->Owner, GetLengthSid(owner->Owner));
  printf(",\"restricted\":%s,\"elevated\":%s,\"tokenType\":%u,\"threadTokenPresent\":%s,\"threadTokenError\":%lu,"
    "\"handleCount\":%lu,\"osBuild\":%lu,\"osMajor\":%lu,\"osMinor\":%lu}\n",
    json_boolean(IsTokenRestricted(token)), json_boolean(elevation.TokenIsElevated), (unsigned)type, json_boolean(threadPresent),
    (unsigned long)threadError, (unsigned long)handles, (unsigned long)version.dwBuildNumber,
    (unsigned long)version.dwMajorVersion, (unsigned long)version.dwMinorVersion);
  free(user); free(owner);
  if (!CloseHandle(token)) return 1;
  return 0;
}

/* Synthetic read tests use a retained parent so ancestor ACL denial cannot masquerade as leaf privacy. */
static NTSTATUS relative_read(HANDLE parent, const wchar_t *name, DWORD *readError, DWORD *readBytes) {
  CreateFileFn create = (CreateFileFn)native_proc("NtCreateFile");
  UNICODE_STRING unicode;
  OBJECT_ATTRIBUTES attributes;
  IO_STATUS_BLOCK io;
  HANDLE file = NULL;
  NTSTATUS status;
  size_t length = wcslen(name);
  BYTE byte;
  *readError = ERROR_SUCCESS; *readBytes = 0;
  if (!create || !length || length > 255 || wcscspn(name, L"\\/:") != length || wcscmp(name, L".") == 0 || wcscmp(name, L"..") == 0) return (NTSTATUS)0xc000000dL;
  ZeroMemory(&attributes, sizeof(attributes)); ZeroMemory(&io, sizeof(io));
  unicode.Length = (USHORT)(length * sizeof(wchar_t)); unicode.MaximumLength = unicode.Length; unicode.Buffer = (PWSTR)name;
  attributes.Length = sizeof(attributes); attributes.RootDirectory = parent;
  attributes.ObjectName = &unicode; attributes.Attributes = 0x1040;
  status = create(&file, FILE_READ_DATA | SYNCHRONIZE, &attributes, &io, NULL, FILE_ATTRIBUTE_NORMAL,
    FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE, 1, 0x200060, NULL, 0);
  if (status == 259) {
    if (!file || WaitForSingleObject(file, 30000) != WAIT_OBJECT_0) {
      fputs("Unsettled native read-open; terminating the test process\n", stderr); ExitProcess(86);
    }
    status = io.Status;
  }
  if (status != 0) return status;
  if (!ReadFile(file, &byte, 1, readBytes, NULL)) *readError = GetLastError();
  if (!CloseHandle(file) && !*readError) *readError = GetLastError();
  return status;
}

static BOOL token_fixture_unavailable(DWORD error) {
  return unavailable(error) || error == ERROR_ACCESS_DENIED || error == ERROR_BAD_IMPERSONATION_LEVEL;
}

static int token_access(const wchar_t *parentPath, const wchar_t *privateName, const wchar_t *controlName, const wchar_t *kind) {
  BOOL anonymousMode = wcscmp(kind, L"anonymous") == 0;
  BOOL restrictedMode = wcscmp(kind, L"restricted") == 0;
  BOOL ordinaryMode = wcscmp(kind, L"ordinary") == 0;
  BOOL impersonating = FALSE, restricted = FALSE, sameUser = FALSE, blocked = FALSE, restored = FALSE;
  BOOL traversalAdjusted = FALSE, parentRestored = FALSE, fatalImpersonation = FALSE;
  HANDLE parent = INVALID_HANDLE_VALUE, processToken = NULL, duplicate = NULL, subject = NULL, thread = NULL;
  TOKEN_USER *owner = NULL, *subjectUser = NULL;
  TOKEN_GROUPS *restrictions = NULL;
  PSECURITY_DESCRIPTOR parentDescriptor = NULL, afterParentDescriptor = NULL;
  PACL parentAcl = NULL, traversalAcl = NULL;
  SECURITY_DESCRIPTOR traversalDescriptor;
  SECURITY_DESCRIPTOR_CONTROL parentControl = 0, afterParentControl = 0;
  DWORD parentRevision = 0;
  DWORD parentBeforeBytes = 0, parentAfterBytes = 0, parentFirstDifference = MAXDWORD;
  NTSTATUS parentMutationStatus = 0, parentRestoreStatus = 0;
  SetSecurityFn setSecurity = (SetSecurityFn)native_proc("NtSetSecurityObject");
  BYTE anonymous[SECURITY_MAX_SID_SIZE];
  DWORD anonymousBytes = sizeof(anonymous), error = ERROR_SUCCESS, threadError = ERROR_SUCCESS;
  DWORD privateError = 0, controlError = 0, privateBytes = 0, controlBytes = 0, ordinaryError = 0, ordinaryBytes = 0;
  NTSTATUS privateStatus = (NTSTATUS)0xc0000001L, controlStatus = (NTSTATUS)0xc0000001L, ordinaryPrivateStatus, ordinaryControlStatus;
  SID_AND_ATTRIBUTES restricting;
  const char *operation = "token fixture";
  if (!anonymousMode && !restrictedMode && !ordinaryMode) return failure("token-access-kind", ERROR_INVALID_PARAMETER, FALSE);
  if (anonymousMode && !setSecurity) return failure("NtSetSecurityObject", ERROR_NOT_SUPPORTED, TRUE);
  if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) { CloseHandle(thread); return failure("ordinary thread required", ERROR_BAD_IMPERSONATION_LEVEL, FALSE); }
  if (GetLastError() != ERROR_NO_TOKEN) return failure("initial OpenThreadToken", GetLastError(), FALSE);
  parent = CreateFileW(parentPath, FILE_LIST_DIRECTORY | FILE_TRAVERSE | FILE_READ_ATTRIBUTES | READ_CONTROL | WRITE_DAC, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  if (parent == INVALID_HANDLE_VALUE) return failure("token-access-parent", GetLastError(), FALSE);
  ordinaryPrivateStatus = relative_read(parent, privateName, &ordinaryError, &ordinaryBytes);
  if (ordinaryPrivateStatus != 0 || ordinaryError) { error = ordinaryError ? ordinaryError : ERROR_ACCESS_DENIED; operation = "ordinary private read prerequisite"; goto cleanup; }
  ordinaryControlStatus = relative_read(parent, controlName, &ordinaryError, &ordinaryBytes);
  if (ordinaryControlStatus != 0 || ordinaryError || ordinaryBytes != 1) { error = ordinaryError ? ordinaryError : ERROR_INVALID_DATA; operation = "ordinary control read prerequisite"; goto cleanup; }
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | (restrictedMode ? TOKEN_DUPLICATE : 0), &processToken)) { error = GetLastError(); operation = "OpenProcessToken"; blocked = token_fixture_unavailable(error); goto cleanup; }
  owner = (TOKEN_USER *)token_information(processToken, TokenUser);
  if (!owner) { error = GetLastError(); operation = "process TokenUser"; goto cleanup; }
  if (!CreateWellKnownSid(WinAnonymousSid, NULL, anonymous, &anonymousBytes)) { error = GetLastError(); operation = "anonymous SID"; goto cleanup; }
  error = GetSecurityInfo(parent, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION, NULL, NULL, &parentAcl, NULL, &parentDescriptor);
  if (error || !parentDescriptor || !parentAcl || !GetSecurityDescriptorControl(parentDescriptor, &parentControl, &parentRevision)) {
    if (!error) error = ERROR_INVALID_SECURITY_DESCR;
    operation = "token parent descriptor"; goto cleanup;
  }
  parentBeforeBytes = GetSecurityDescriptorLength(parentDescriptor);
  if (anonymousMode) {
    DWORD bytes = parentAcl->AclSize + (DWORD)offsetof(ACCESS_ALLOWED_ACE, SidStart) + anonymousBytes;
    if (bytes > MAXWORD) { error = ERROR_INVALID_ACL; operation = "token traverse ACL bounds"; goto cleanup; }
    traversalAcl = (PACL)calloc(1, bytes);
    if (!traversalAcl) { error = ERROR_OUTOFMEMORY; operation = "token traverse ACL"; goto cleanup; }
    memcpy(traversalAcl, parentAcl, parentAcl->AclSize);
    traversalAcl->AclSize = (WORD)bytes;
    if (!AddAccessAllowedAceEx(traversalAcl, ACL_REVISION, 0, FILE_TRAVERSE, anonymous)) {
      error = GetLastError(); operation = "token traverse ACE"; goto cleanup;
    }
    if (!InitializeSecurityDescriptor(&traversalDescriptor, SECURITY_DESCRIPTOR_REVISION) ||
        !SetSecurityDescriptorDacl(&traversalDescriptor, TRUE, traversalAcl, FALSE) ||
        !SetSecurityDescriptorControl(&traversalDescriptor, SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ,
          (SECURITY_DESCRIPTOR_CONTROL)(parentControl & (SE_DACL_PROTECTED | SE_DACL_AUTO_INHERITED | SE_DACL_AUTO_INHERIT_REQ)))) {
      error = GetLastError(); operation = "token traverse descriptor"; goto cleanup;
    }
    /* Preserve descriptor control bits without SetSecurityInfo's inheritance propagation. */
    traversalAdjusted = TRUE;
    parentMutationStatus = setSecurity(parent, DACL_SECURITY_INFORMATION, &traversalDescriptor);
    if (parentMutationStatus != 0) { error = ERROR_INVALID_SECURITY_DESCR; operation = "token parent traversal control"; goto cleanup; }
  }
  if (restrictedMode) {
    if (IsTokenRestricted(processToken)) { error = ERROR_ACCESS_DENIED; operation = "unrestricted process prerequisite"; blocked = TRUE; goto cleanup; }
    if (!DuplicateTokenEx(processToken, TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_IMPERSONATE, NULL, SecurityImpersonation, TokenImpersonation, &duplicate)) { error = GetLastError(); operation = "DuplicateTokenEx"; blocked = token_fixture_unavailable(error); goto cleanup; }
    restricting.Sid = anonymous; restricting.Attributes = 0;
    if (!CreateRestrictedToken(duplicate, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 1, &restricting, &subject)) { error = GetLastError(); operation = "CreateRestrictedToken"; blocked = token_fixture_unavailable(error); goto cleanup; }
    subjectUser = (TOKEN_USER *)token_information(subject, TokenUser);
    restrictions = (TOKEN_GROUPS *)token_information(subject, TokenRestrictedSids);
    restricted = IsTokenRestricted(subject);
    if (!subjectUser || !restrictions || !restricted || !EqualSid(subjectUser->User.Sid, owner->User.Sid)
        || restrictions->GroupCount != 1 || !EqualSid(restrictions->Groups[0].Sid, anonymous)) { error = ERROR_INVALID_DATA; operation = "restricted token facts"; goto cleanup; }
    sameUser = TRUE;
    if (!SetThreadToken(NULL, subject)) { error = GetLastError(); operation = "SetThreadToken restricted"; blocked = token_fixture_unavailable(error); goto cleanup; }
    impersonating = TRUE;
  } else if (anonymousMode) {
    if (!ImpersonateAnonymousToken(GetCurrentThread())) { error = GetLastError(); operation = "ImpersonateAnonymousToken"; blocked = token_fixture_unavailable(error); goto cleanup; }
    impersonating = TRUE;
  } else sameUser = TRUE;
  if (!ordinaryMode) {
    if (OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) {
      if (anonymousMode) {
        subjectUser = (TOKEN_USER *)token_information(thread, TokenUser);
        if (!subjectUser || !EqualSid(subjectUser->User.Sid, anonymous)) { error = ERROR_INVALID_DATA; operation = "anonymous thread identity"; }
      } else if (!IsTokenRestricted(thread)) { error = ERROR_INVALID_DATA; operation = "restricted thread identity"; }
      CloseHandle(thread); thread = NULL;
    } else {
      threadError = GetLastError();
      if (!(anonymousMode && threadError == ERROR_CANT_OPEN_ANONYMOUS)) { error = threadError; operation = "installed thread token query"; }
    }
    if (error) goto cleanup;
  }
  controlStatus = relative_read(parent, controlName, &controlError, &controlBytes);
  privateStatus = relative_read(parent, privateName, &privateError, &privateBytes);
cleanup:
  if (impersonating && !RevertToSelf()) {
    error = GetLastError(); operation = "RevertToSelf"; fatalImpersonation = TRUE; blocked = FALSE;
  }
  if (!fatalImpersonation && OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &thread)) {
    CloseHandle(thread); thread = NULL; error = ERROR_BAD_IMPERSONATION_LEVEL; operation = "thread token remained after reversion"; blocked = FALSE;
  } else if (!fatalImpersonation) {
    if (GetLastError() == ERROR_NO_TOKEN) restored = TRUE;
    else { error = GetLastError(); operation = "reverted thread token query"; blocked = FALSE; }
  }
  if (parentDescriptor) {
    DWORD parentError = ERROR_SUCCESS;
    if (traversalAdjusted) {
      parentRestoreStatus = setSecurity(parent, DACL_SECURITY_INFORMATION, parentDescriptor);
      if (parentRestoreStatus != 0) parentError = ERROR_INVALID_SECURITY_DESCR;
    }
    if (!parentError) parentError = GetSecurityInfo(parent, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
      NULL, NULL, NULL, NULL, &afterParentDescriptor);
    if (!parentError && afterParentDescriptor) {
      if (!GetSecurityDescriptorControl(afterParentDescriptor, &afterParentControl, &parentRevision)) parentError = ERROR_INVALID_SECURITY_DESCR;
      else {
        DWORD limit;
        parentAfterBytes = GetSecurityDescriptorLength(afterParentDescriptor);
        limit = parentBeforeBytes < parentAfterBytes ? parentBeforeBytes : parentAfterBytes;
        for (parentFirstDifference = 0; parentFirstDifference < limit; parentFirstDifference++)
          if (((BYTE *)parentDescriptor)[parentFirstDifference] != ((BYTE *)afterParentDescriptor)[parentFirstDifference]) break;
        if (parentFirstDifference == limit && parentBeforeBytes == parentAfterBytes) parentFirstDifference = MAXDWORD;
      }
    }
    if (!parentError && afterParentDescriptor && parentBeforeBytes == parentAfterBytes
      && memcmp(parentDescriptor, afterParentDescriptor, parentBeforeBytes) == 0) parentRestored = TRUE;
    else { error = parentError ? parentError : ERROR_INVALID_SECURITY_DESCR; operation = "token parent descriptor restoration"; blocked = FALSE; }
  }
  if (afterParentDescriptor) LocalFree(afterParentDescriptor);
  if (parentDescriptor) LocalFree(parentDescriptor);
  free(traversalAcl);
  if (subject) CloseHandle(subject);
  if (duplicate) CloseHandle(duplicate);
  if (processToken) CloseHandle(processToken);
  if (parent != INVALID_HANDLE_VALUE) CloseHandle(parent);
  if (fatalImpersonation) {
    fprintf(stderr, "RevertToSelf failed; parent descriptor restored=%s; terminating fixture\n", json_boolean(parentRestored));
    ExitProcess(86);
  }
  if (error) {
    free(owner); free(subjectUser); free(restrictions);
    printf("{\"complete\":false,\"status\":\"%s\",\"operation\":", blocked ? "blocked" : "failed"); json_string(operation);
    printf(",\"win32Error\":%lu,\"parentMutationStatus\":%ld,\"parentRestoreStatus\":%ld,\"parentBeforeControl\":%u,\"parentAfterControl\":%u,"
      "\"parentBeforeBytes\":%lu,\"parentAfterBytes\":%lu,\"parentFirstDifference\":%lu,"
      "\"controlStatus\":%ld,\"controlReadBytes\":%lu,\"privateStatus\":%ld,\"privateReadBytes\":%lu,\"threadRestored\":%s}\n",
      (unsigned long)error, (long)parentMutationStatus, (long)parentRestoreStatus, (unsigned)parentControl, (unsigned)afterParentControl,
      (unsigned long)parentBeforeBytes, (unsigned long)parentAfterBytes, (unsigned long)parentFirstDifference,
      (long)controlStatus, (unsigned long)controlBytes, (long)privateStatus, (unsigned long)privateBytes, json_boolean(restored));
    return blocked ? 3 : 1;
  }
  if (controlStatus != 0 || controlError || controlBytes != 1) {
    printf("{\"complete\":false,\"status\":\"blocked\",\"operation\":\"token readable-control prerequisite\",\"nativeStatus\":%ld,\"win32Error\":%lu,\"threadRestored\":%s}\n",
      (long)controlStatus, (unsigned long)controlError, json_boolean(restored));
    free(owner); free(subjectUser); free(restrictions); return 3;
  }
  printf("{\"complete\":true,\"subject\":\"%s\",\"ownerSid\":", anonymousMode ? "anonymous" : restrictedMode ? "same-user-restricted" : "ordinary");
  hex(owner->User.Sid, GetLengthSid(owner->User.Sid));
  printf(",\"subjectSid\":");
  if (anonymousMode) hex(anonymous, anonymousBytes); else hex(owner->User.Sid, GetLengthSid(owner->User.Sid));
  printf(",\"sameUser\":%s,\"restricted\":%s,\"threadTokenError\":%lu,\"ordinaryPrivateReadable\":true,\"controlStatus\":%ld,\"controlReadBytes\":%lu,"
    "\"privateStatus\":%ld,\"privateReadError\":%lu,\"privateReadBytes\":%lu,\"threadRestored\":%s,\"privilegesEnabled\":false,"
    "\"parentTraversalAdjusted\":%s,\"parentTraversalMask\":%lu,\"parentDescriptorRestored\":%s,"
    "\"parentTraversalMechanism\":\"%s\",\"parentMutationStatus\":%ld,\"parentRestoreStatus\":%ld}\n",
    json_boolean(sameUser), json_boolean(restricted), (unsigned long)threadError, (long)controlStatus, (unsigned long)controlBytes,
    (long)privateStatus, (unsigned long)privateError, (unsigned long)privateBytes, json_boolean(restored),
    json_boolean(traversalAdjusted), (unsigned long)(traversalAdjusted ? FILE_TRAVERSE : 0), json_boolean(parentRestored),
    traversalAdjusted ? "NtSetSecurityObject" : "not-needed", (long)parentMutationStatus, (long)parentRestoreStatus);
  free(owner); free(subjectUser); free(restrictions);
  return 0;
}

static BOOL valid_aces(PACL acl) {
  DWORD i;
  uintptr_t start, end;
  if (!acl) return TRUE;
  if (!IsValidAcl(acl)) return FALSE;
  start = (uintptr_t)acl; end = start + acl->AclSize;
  for (i = 0; i < acl->AceCount; ++i) {
    ACE_HEADER *ace;
    uintptr_t address;
    if (!GetAce(acl, i, (void **)&ace)) return FALSE;
    address = (uintptr_t)ace;
    if (address < start + sizeof(ACL) || address > end - sizeof(ACE_HEADER) || ace->AceSize < sizeof(ACE_HEADER) ||
        (size_t)ace->AceSize > end - address) return FALSE;
    if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE || ace->AceType == ACCESS_DENIED_ACE_TYPE) {
      PSID sid;
      DWORD sidBytes;
      if (ace->AceSize < offsetof(ACCESS_ALLOWED_ACE, SidStart) + 8) return FALSE;
      sid = &((ACCESS_ALLOWED_ACE *)ace)->SidStart;
      sidBytes = GetSidLengthRequired(((SID *)sid)->SubAuthorityCount);
      if (sidBytes > ace->AceSize - offsetof(ACCESS_ALLOWED_ACE, SidStart) || !IsValidSid(sid)) return FALSE;
    }
  }
  return TRUE;
}

static int inspect_handle(HANDLE file, BOOL descriptorOnly) {
  FILE_ID_INFO id = {0};
  FILE_STANDARD_INFO standard = {0};
  FILE_BASIC_INFO basic = {0};
  FILE_ATTRIBUTE_TAG_INFO tag = {0};
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL acl = NULL;
  SECURITY_DESCRIPTOR_CONTROL control = 0;
  DWORD revision = 0, error, fileType, flags = 0, serial = 0, maximumComponent = 0, i, descriptorLength;
  BOOL present = FALSE, defaulted = FALSE;
  wchar_t filesystem[64] = {0};
  char filesystemAscii[64] = {0};
  IO_STATUS_BLOCK iosb;
  ORACLE_FILE_MODE_INFORMATION mode;
  ORACLE_FS_DEVICE_INFORMATION device;
  NTSTATUS modeStatus, deviceStatus;
  LPSTR ownerText = NULL;
  QueryFileFn query = (QueryFileFn)native_proc("NtQueryInformationFile");
  QueryVolumeFn volume = (QueryVolumeFn)native_proc("NtQueryVolumeInformationFile");
  if (!query || !volume) return failure("native-query-unavailable", ERROR_NOT_SUPPORTED, FALSE);
  error = ERROR_SUCCESS;
  ZeroMemory(&mode, sizeof(mode)); ZeroMemory(&device, sizeof(device));
  if (!GetFileInformationByHandleEx(file, FileIdInfo, &id, sizeof(id)) ||
      !GetFileInformationByHandleEx(file, FileStandardInfo, &standard, sizeof(standard))) error = GetLastError();
  if (!descriptorOnly && (!GetFileInformationByHandleEx(file, FileBasicInfo, &basic, sizeof(basic)) ||
      !GetFileInformationByHandleEx(file, FileAttributeTagInfo, &tag, sizeof(tag)) ||
      !GetVolumeInformationByHandleW(file, NULL, 0, &serial, &maximumComponent, &flags, filesystem, 64))) error = GetLastError();
  fileType = GetFileType(file);
  ZeroMemory(&iosb, sizeof(iosb));
  modeStatus = query(file, &iosb, &mode, sizeof(mode), 16);
  if (!descriptorOnly && (modeStatus == 259 || modeStatus < 0 || iosb.Information != sizeof(mode))) error = ERROR_INVALID_DATA;
  ZeroMemory(&iosb, sizeof(iosb));
  deviceStatus = volume(file, &iosb, &device, sizeof(device), 4);
  if (!descriptorOnly && (deviceStatus == 259 || deviceStatus < 0 || iosb.Information != sizeof(device))) error = ERROR_INVALID_DATA;
  if (!error) error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION | DACL_SECURITY_INFORMATION,
    &owner, NULL, &acl, NULL, &descriptor);
  if (!error && (!descriptor || !IsValidSecurityDescriptor(descriptor) || !owner || !IsValidSid(owner) ||
      !GetSecurityDescriptorControl(descriptor, &control, &revision) ||
      !GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) || !valid_aces(acl))) error = ERROR_INVALID_SECURITY_DESCR;
  if (!error && !ConvertSidToStringSidA(owner, &ownerText)) error = GetLastError();
  if (!error && !descriptorOnly && !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, filesystem, -1, filesystemAscii, sizeof(filesystemAscii), NULL, NULL)) error = GetLastError();
  if (error) { if (ownerText) LocalFree(ownerText); if (descriptor) LocalFree(descriptor); return failure("inspect-facts", error, FALSE); }
  descriptorLength = GetSecurityDescriptorLength(descriptor);
  printf("{\"complete\":true,\"inspectionScope\":\"%s\",", descriptorOnly ? "security-descriptor" : "full-handle-facts");
  printf("\"identity\":{\"volumeSerial\":\"%016llx\",\"fileId\":", (unsigned long long)id.VolumeSerialNumber);
  hex(id.FileId.Identifier, sizeof(id.FileId.Identifier));
  printf("},");
  printf("\"ownerSid\":"); hex(owner, GetLengthSid(owner));
  printf(",\"ownerSidText\":"); json_string(ownerText);
  printf(",\"descriptorHex\":"); hex(descriptor, descriptorLength);
  printf(",\"descriptorControl\":%u,\"daclPresent\":%s,\"daclNull\":%s,\"daclProtected\":%s,\"aces\":[",
    (unsigned)control, json_boolean(present), json_boolean(acl == NULL), json_boolean(control & SE_DACL_PROTECTED));
  if (acl) for (i = 0; i < acl->AceCount; ++i) {
    ACE_HEADER *ace;
    GetAce(acl, i, (void **)&ace);
    printf("%s{\"type\":%u,\"flags\":%u,\"bytes\":%u,\"rawHex\":", i ? "," : "", (unsigned)ace->AceType, (unsigned)ace->AceFlags, (unsigned)ace->AceSize);
    hex(ace, ace->AceSize);
    printf(",\"mask\":");
    if (ace->AceSize >= sizeof(ACE_HEADER) + sizeof(ACCESS_MASK)) printf("%lu", (unsigned long)((ACCESS_ALLOWED_ACE *)ace)->Mask); else printf("null");
    printf(",\"sid\":");
    if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE || ace->AceType == ACCESS_DENIED_ACE_TYPE) {
      PSID sid = &((ACCESS_ALLOWED_ACE *)ace)->SidStart; hex(sid, GetLengthSid(sid));
    } else printf("null");
    putchar('}');
  }
  if (descriptorOnly) {
    printf("],\"sizeBytes\":\"%lld\",\"links\":%lu}\n", (long long)standard.EndOfFile.QuadPart, (unsigned long)standard.NumberOfLinks);
    LocalFree(ownerText); LocalFree(descriptor);
    return 0;
  }
  printf("],\"directory\":%s,\"links\":%lu,\"sizeBytes\":\"%lld\",\"attributes\":%lu,\"reparseTag\":%lu,"
    "\"fileType\":%lu,\"mode\":%lu,\"modeScope\":\"independently-opened-oracle-handle\",\"modeStatus\":%ld,"
    "\"filesystem\":", json_boolean(standard.Directory), (unsigned long)standard.NumberOfLinks, (long long)standard.EndOfFile.QuadPart,
    (unsigned long)basic.FileAttributes, (unsigned long)tag.ReparseTag, (unsigned long)fileType, (unsigned long)mode.Mode, (long)modeStatus);
  json_string(filesystemAscii);
  printf(",\"filesystemFlags\":%lu,\"maximumComponentLength\":%lu,\"deviceType\":%lu,\"deviceCharacteristics\":%lu,"
    "\"remote\":%s,\"deviceStatus\":%ld}\n", (unsigned long)flags, (unsigned long)maximumComponent, (unsigned long)device.DeviceType,
    (unsigned long)device.Characteristics, json_boolean(device.Characteristics & 0x10), (long)deviceStatus);
  LocalFree(ownerText); LocalFree(descriptor);
  return 0;
}

static int inspect(const wchar_t *path, BOOL descriptorOnly) {
  HANDLE file = CreateFileW(path, READ_CONTROL | FILE_READ_ATTRIBUTES, FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
    NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  int result;
  if (file == INVALID_HANDLE_VALUE) return failure("CreateFileW-inspect", GetLastError(), FALSE);
  result = inspect_handle(file, descriptorOnly);
  if (!CloseHandle(file)) return 1;
  return result;
}

static int create_fixture(const wchar_t *path, BOOL directory, const wchar_t *policy, HANDLE *retained) {
  HANDLE token = NULL, file = INVALID_HANDLE_VALUE;
  TOKEN_USER *user;
  SECURITY_DESCRIPTOR descriptor;
  SECURITY_ATTRIBUTES attributes;
  DWORD error = ERROR_SUCCESS, aclBytes, flags = directory ? OBJECT_INHERIT_ACE | CONTAINER_INHERIT_ACE : 0;
  PACL acl;
  BYTE world[SECURITY_MAX_SID_SIZE];
  DWORD worldBytes = sizeof(world);
  BOOL isPublic = wcscmp(policy, L"public") == 0, isNull = wcscmp(policy, L"null") == 0;
  BOOL absent = wcscmp(policy, L"absent") == 0, empty = wcscmp(policy, L"empty") == 0;
  BOOL inherited = wcscmp(policy, L"inherited") == 0, denyFirst = wcscmp(policy, L"deny-first") == 0;
  BOOL objectAce = wcscmp(policy, L"object") == 0, callbackAce = wcscmp(policy, L"callback") == 0;
  BOOL anonymousPublic = wcscmp(policy, L"anonymous-public") == 0;
  GUID objectType = { 0x2f4b5931, 0xa8d2, 0x40b4, { 0xa8, 0x57, 0x35, 0x78, 0x10, 0x90, 0x4f, 0xee } };
  DWORD aclRevision = objectAce || callbackAce ? ACL_REVISION_DS : ACL_REVISION;
  if (!isPublic && !isNull && !absent && !empty && !inherited && !denyFirst && !objectAce && !callbackAce && !anonymousPublic && wcscmp(policy, L"private") != 0)
    return failure("fixture-policy", ERROR_INVALID_PARAMETER, FALSE);
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token)) return failure("OpenProcessToken", GetLastError(), FALSE);
  user = (TOKEN_USER *)token_information(token, TokenUser);
  if (!user) { error = GetLastError(); CloseHandle(token); return failure("TokenUser", error, FALSE); }
  if (!CreateWellKnownSid(WinWorldSid, NULL, world, &worldBytes)) { error = GetLastError(); free(user); CloseHandle(token); return failure("CreateWellKnownSid", error, FALSE); }
  aclBytes = sizeof(ACL) + 3 * (sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE);
  acl = (PACL)calloc(1, aclBytes);
  if (!acl) error = ERROR_OUTOFMEMORY;
  if (!error && (!InitializeSecurityDescriptor(&descriptor, SECURITY_DESCRIPTOR_REVISION) ||
      !SetSecurityDescriptorOwner(&descriptor, user->User.Sid, FALSE) ||
      !InitializeAcl(acl, aclBytes, aclRevision))) error = GetLastError();
  if (!error && denyFirst && !AddAccessDeniedAceEx(acl, ACL_REVISION, flags, FILE_WRITE_DATA, world)) error = GetLastError();
  if (!error && !empty && !isNull && !absent && !objectAce && !callbackAce && !AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, user->User.Sid)) error = GetLastError();
  if (!error && objectAce && !AddAccessAllowedObjectAce(acl, ACL_REVISION_DS, flags, FILE_ALL_ACCESS, &objectType, NULL, user->User.Sid)) error = GetLastError();
  if (!error && callbackAce) {
    BYTE buffer[sizeof(ACCESS_ALLOWED_ACE) + SECURITY_MAX_SID_SIZE];
    ACCESS_ALLOWED_ACE *ace = (ACCESS_ALLOWED_ACE *)buffer;
    DWORD length = (DWORD)offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(user->User.Sid);
    ZeroMemory(buffer, sizeof(buffer));
    ace->Header.AceType = ACCESS_ALLOWED_CALLBACK_ACE_TYPE;
    ace->Header.AceFlags = (BYTE)flags;
    ace->Header.AceSize = (WORD)length;
    ace->Mask = FILE_ALL_ACCESS;
    if (!CopySid(SECURITY_MAX_SID_SIZE, &ace->SidStart, user->User.Sid) || !AddAce(acl, ACL_REVISION_DS, MAXDWORD, buffer, length)) error = GetLastError();
  }
  if (!error && isPublic && !AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_ALL_ACCESS, world)) error = GetLastError();
  if (!error && anonymousPublic) {
    BYTE anonymous[SECURITY_MAX_SID_SIZE];
    DWORD anonymousBytes = sizeof(anonymous);
    if (!CreateWellKnownSid(WinAnonymousSid, NULL, anonymous, &anonymousBytes) ||
        !AddAccessAllowedAceEx(acl, ACL_REVISION, flags, FILE_GENERIC_READ, anonymous)) error = GetLastError();
  }
  if (!error) {
    ACL_SIZE_INFORMATION size;
    if (!GetAclInformation(acl, &size, sizeof(size), AclSizeInformation)) error = GetLastError();
    else acl->AclSize = (WORD)size.AclBytesInUse;
  }
  if (!error && (!SetSecurityDescriptorDacl(&descriptor, !absent, isNull ? NULL : acl, FALSE) ||
      !SetSecurityDescriptorControl(&descriptor, SE_DACL_PROTECTED, inherited ? 0 : SE_DACL_PROTECTED))) error = GetLastError();
  attributes.nLength = sizeof(attributes); attributes.lpSecurityDescriptor = &descriptor; attributes.bInheritHandle = FALSE;
  if (!error) {
    if (directory) { if (!CreateDirectoryW(path, &attributes)) error = GetLastError(); }
    else {
      file = CreateFileW(path, READ_CONTROL | (retained ? WRITE_DAC | FILE_READ_ATTRIBUTES : 0), FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        &attributes, CREATE_NEW, FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT, NULL);
      if (file == INVALID_HANDLE_VALUE) error = GetLastError();
      else if (retained) *retained = file;
      else if (!CloseHandle(file)) error = GetLastError();
    }
  }
  free(acl); free(user); CloseHandle(token);
  if (error) return failure("create-fixture", error, unavailable(error) || ((objectAce || callbackAce) && (error == ERROR_INVALID_ACL || error == ERROR_INVALID_SECURITY_DESCR)));
  if (!retained) printf("{\"complete\":true,\"created\":true}\n");
  return 0;
}

/* Only this exclusively created fixture is restored, after both descriptor observations. */
static DWORD restore_fixture_acl(HANDLE file) {
  PSECURITY_DESCRIPTOR descriptor = NULL;
  PSID owner = NULL;
  PACL acl = NULL;
  DWORD error = GetSecurityInfo(file, SE_FILE_OBJECT, OWNER_SECURITY_INFORMATION, &owner, NULL, NULL, NULL, &descriptor);
  if (!error && (!owner || !IsValidSid(owner))) error = ERROR_INVALID_SID;
  if (!error) {
    DWORD bytes = (DWORD)sizeof(ACL) + (DWORD)offsetof(ACCESS_ALLOWED_ACE, SidStart) + GetLengthSid(owner);
    acl = (PACL)calloc(1, bytes);
    if (!acl) error = ERROR_OUTOFMEMORY;
    else if (!InitializeAcl(acl, bytes, ACL_REVISION) || !AddAccessAllowedAceEx(acl, ACL_REVISION, 0, FILE_ALL_ACCESS, owner)) error = GetLastError();
    else error = SetSecurityInfo(file, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, NULL, NULL, acl, NULL);
  }
  free(acl);
  if (descriptor) LocalFree(descriptor);
  return error;
}

/* No DELETE access is retained: the product's non-delete-shared opens still reach the ACL check. */
static int hold_descriptor(const wchar_t *path, const wchar_t *policy) {
  HANDLE file = INVALID_HANDLE_VALUE;
  char command[32];
  DWORD error;
  int result = create_fixture(path, FALSE, policy, &file);
  if (result) return result;
  result = inspect_handle(file, TRUE);
  fflush(stdout);
  while (!result && fgets(command, sizeof(command), stdin)) {
    if (strcmp(command, "close\n") == 0 || strcmp(command, "close\r\n") == 0) break;
    if (strcmp(command, "inspect\n") != 0 && strcmp(command, "inspect\r\n") != 0) { result = failure("hold-descriptor-command", ERROR_INVALID_PARAMETER, FALSE); break; }
    result = inspect_handle(file, TRUE);
    fflush(stdout);
  }
  error = restore_fixture_acl(file);
  if (!CloseHandle(file) && !error) error = GetLastError();
  if (error) return failure("hold-descriptor-cleanup", error, FALSE);
  return result;
}

static int print_retained_bytes(HANDLE file) {
  LARGE_INTEGER zero, size;
  DWORD count;
  BYTE bytes[65536];
  zero.QuadPart = 0;
  if (!GetFileSizeEx(file, &size) || size.QuadPart < 0 || size.QuadPart > (LONGLONG)sizeof(bytes)) return failure("retained-read-limit", ERROR_FILE_TOO_LARGE, FALSE);
  if (!SetFilePointerEx(file, zero, NULL, FILE_BEGIN) || !ReadFile(file, bytes, (DWORD)size.QuadPart, &count, NULL)) return failure("retained-read", GetLastError(), FALSE);
  if ((LONGLONG)count != size.QuadPart) return failure("retained-short-read", ERROR_INVALID_DATA, FALSE);
  printf("{\"complete\":true,\"bytesHex\":"); hex(bytes, count); printf("}\n"); fflush(stdout);
  return 0;
}

static int hold_reader(const wchar_t *path, BOOL shareDelete) {
  HANDLE file = CreateFileW(path, GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE | (shareDelete ? FILE_SHARE_DELETE : 0),
    NULL, OPEN_EXISTING, FILE_FLAG_OPEN_REPARSE_POINT, NULL);
  char command[32];
  int result;
  if (file == INVALID_HANDLE_VALUE) return failure("hold-reader-open", GetLastError(), FALSE);
  result = print_retained_bytes(file);
  while (!result && fgets(command, sizeof(command), stdin)) {
    if (strcmp(command, "close\n") == 0 || strcmp(command, "close\r\n") == 0) break;
    if (strcmp(command, "read\n") != 0 && strcmp(command, "read\r\n") != 0) { result = failure("hold-reader-command", ERROR_INVALID_PARAMETER, FALSE); break; }
    result = print_retained_bytes(file);
  }
  if (!CloseHandle(file)) return failure("hold-reader-close", GetLastError(), FALSE);
  return result;
}

/* Only caller-derived primary tokens launch this bounded, job-owned synthetic child. */
static BOOL primary_append_argument(wchar_t *command, size_t capacity, size_t *used, const wchar_t *value) {
  size_t i, slashes;
  if (*used && *used + 1 < capacity) command[(*used)++] = L' ';
  if (*used + 2 >= capacity) return FALSE;
  command[(*used)++] = L'"';
  for (i = 0; ; i++) {
    slashes = 0;
    while (value[i] == L'\\') { slashes++; i++; }
    if (value[i] == L'"' || value[i] == L'\0') slashes *= 2;
    while (slashes--) { if (*used + 2 >= capacity) return FALSE; command[(*used)++] = L'\\'; }
    if (value[i] == L'\0') break;
    if (value[i] == L'"') { if (*used + 2 >= capacity) return FALSE; command[(*used)++] = L'\\'; }
    if (*used + 2 >= capacity) return FALSE;
    command[(*used)++] = value[i];
  }
  command[(*used)++] = L'"'; command[*used] = L'\0'; return TRUE;
}

static int primary_process(int argc, wchar_t **argv) {
  HANDLE original = NULL, restrictedToken = NULL, childToken = NULL, threadToken = NULL, job = NULL;
  TOKEN_USER *user = NULL, *childUser = NULL;
  TOKEN_GROUPS *groups = NULL, *logon = NULL, *childLogon = NULL;
  TOKEN_TYPE type = TokenImpersonation;
  SID_AND_ATTRIBUTES restrictions[3];
  BYTE everyone[SECURITY_MAX_SID_SIZE];
  DWORD everyoneBytes = sizeof(everyone), bytes, error = ERROR_SUCCESS, exitCode = STILL_ACTIVE, threadError = 0;
  DWORD restrictedCount = 0, waited, childPid = 0;
  BOOL restricted = wcscmp(argv[2], L"restricted") == 0, blocked = FALSE, started = FALSE, exited = FALSE;
  BOOL tokenRestricted = FALSE, sameUser = FALSE, threadAbsent = FALSE, jobEmpty = FALSE, cleanupOk = TRUE;
  const char *operation = "primary process fixture";
  STARTUPINFOW startup;
  PROCESS_INFORMATION child;
  JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits;
  JOBOBJECT_BASIC_ACCOUNTING_INFORMATION accounting;
  wchar_t command[32768]; size_t used = 0; int i;
  ULONGLONG deadline;
  ZeroMemory(&startup, sizeof(startup)); startup.cb = sizeof(startup);
  ZeroMemory(&child, sizeof(child)); ZeroMemory(&limits, sizeof(limits));
  if (!restricted && wcscmp(argv[2], L"ordinary") != 0) return failure("primary process mode", ERROR_INVALID_PARAMETER, FALSE);
  for (i = 3; i < argc; i++) if (!primary_append_argument(command, 32768, &used, argv[i])) return failure("primary process arguments", ERROR_BAD_LENGTH, FALSE);
  if (!OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, TRUE, &threadToken)) {
    if (GetLastError() != ERROR_NO_TOKEN) { error = GetLastError(); goto cleanup; }
  } else { error = ERROR_BAD_TOKEN_TYPE; operation = "fixture caller impersonation"; goto cleanup; }
  if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY, &original)) {
    error = GetLastError(); operation = "OpenProcessToken primary fixture"; blocked = token_fixture_unavailable(error); goto cleanup;
  }
  user = (TOKEN_USER *)token_information(original, TokenUser);
  if (!user || IsTokenRestricted(original)) { error = ERROR_BAD_TOKEN_TYPE; operation = "ordinary caller primary token"; goto cleanup; }
  logon = (TOKEN_GROUPS *)token_information(original, TokenLogonSid);
  if (!logon || logon->GroupCount != 1 || (logon->Groups[0].Attributes & SE_GROUP_LOGON_ID) != SE_GROUP_LOGON_ID) {
    error = ERROR_NOT_SUPPORTED; operation = "caller logon SID unavailable"; blocked = TRUE; goto cleanup;
  }
  if (restricted) {
    if (!CreateWellKnownSid(WinWorldSid, NULL, everyone, &everyoneBytes)) { error = GetLastError(); operation = "primary restricting SID"; goto cleanup; }
    ZeroMemory(restrictions, sizeof(restrictions)); restrictions[0].Sid = user->User.Sid; restrictions[1].Sid = everyone;
    restrictions[2].Sid = logon->Groups[0].Sid;
    if (!CreateRestrictedToken(original, DISABLE_MAX_PRIVILEGE, 0, NULL, 0, NULL, 3, restrictions, &restrictedToken)) {
      error = GetLastError(); operation = "CreateRestrictedToken primary"; blocked = token_fixture_unavailable(error); goto cleanup;
    }
  }
  job = CreateJobObjectW(NULL, NULL);
  limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
  if (!job || !SetInformationJobObject(job, JobObjectExtendedLimitInformation, &limits, sizeof(limits))) {
    error = GetLastError(); operation = "primary child job"; goto cleanup;
  }
  started = restricted
    ? CreateProcessAsUserW(restrictedToken, argv[3], command, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &child)
    : CreateProcessW(argv[3], command, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_NO_WINDOW, NULL, NULL, &startup, &child);
  if (!started) { error = GetLastError(); operation = "create primary child"; blocked = token_fixture_unavailable(error); goto cleanup; }
  childPid = child.dwProcessId;
  if (!AssignProcessToJobObject(job, child.hProcess)) { error = GetLastError(); operation = "assign primary child job"; goto cleanup; }
  if (!OpenProcessToken(child.hProcess, TOKEN_QUERY, &childToken)) { error = GetLastError(); operation = "query actual child primary token"; goto cleanup; }
  childUser = (TOKEN_USER *)token_information(childToken, TokenUser);
  groups = (TOKEN_GROUPS *)token_information(childToken, TokenRestrictedSids);
  childLogon = (TOKEN_GROUPS *)token_information(childToken, TokenLogonSid);
  if (!childUser || !groups || !childLogon || !GetTokenInformation(childToken, TokenType, &type, sizeof(type), &bytes)) {
    error = GetLastError(); operation = "actual child primary token facts"; goto cleanup;
  }
  sameUser = EqualSid(user->User.Sid, childUser->User.Sid); tokenRestricted = IsTokenRestricted(childToken); restrictedCount = groups->GroupCount;
  threadAbsent = !OpenThreadToken(child.hThread, TOKEN_QUERY, TRUE, &threadToken);
  threadError = threadAbsent ? GetLastError() : ERROR_SUCCESS;
  if (!sameUser || type != TokenPrimary || tokenRestricted != restricted || (restricted && restrictedCount != 3)
      || childLogon->GroupCount != 1 || !EqualSid(logon->Groups[0].Sid, childLogon->Groups[0].Sid)
      || !threadAbsent || threadError != ERROR_NO_TOKEN) {
    error = ERROR_BAD_TOKEN_TYPE; operation = "actual primary child identity mismatch"; goto cleanup;
  }
  if (restricted) {
    DWORD expectedIndex, observedIndex;
    for (expectedIndex = 0; expectedIndex < 3; expectedIndex++) {
      BOOL found = FALSE;
      for (observedIndex = 0; observedIndex < restrictedCount; observedIndex++)
        if (EqualSid(restrictions[expectedIndex].Sid, groups->Groups[observedIndex].Sid)) found = TRUE;
      if (!found) { error = ERROR_BAD_TOKEN_TYPE; operation = "actual restricting SID mismatch"; goto cleanup; }
    }
  }
  if (ResumeThread(child.hThread) == (DWORD)-1) { error = GetLastError(); operation = "resume primary child"; goto cleanup; }
  waited = WaitForSingleObject(child.hProcess, 15000);
  if (waited != WAIT_OBJECT_0) { error = waited == WAIT_TIMEOUT ? ERROR_TIMEOUT : GetLastError(); operation = "primary child completion"; goto cleanup; }
  exited = TRUE;
  if (!GetExitCodeProcess(child.hProcess, &exitCode)) { error = GetLastError(); operation = "primary child exit code"; goto cleanup; }
cleanup:
  if (started && !exited) {
    if (!TerminateProcess(child.hProcess, 87) || WaitForSingleObject(child.hProcess, 5000) != WAIT_OBJECT_0) cleanupOk = FALSE;
    else exited = TRUE;
  }
  if (job) {
    if (!TerminateJobObject(job, 87)) cleanupOk = FALSE;
    deadline = GetTickCount64() + 5000;
    do {
      ZeroMemory(&accounting, sizeof(accounting));
      if (!QueryInformationJobObject(job, JobObjectBasicAccountingInformation, &accounting, sizeof(accounting), NULL)) { cleanupOk = FALSE; break; }
      if (accounting.ActiveProcesses == 0) { jobEmpty = TRUE; break; }
      Sleep(10);
    } while (GetTickCount64() < deadline);
    if (!jobEmpty) cleanupOk = FALSE;
  }
  if (threadToken && !CloseHandle(threadToken)) cleanupOk = FALSE;
  if (childToken && !CloseHandle(childToken)) cleanupOk = FALSE;
  if (child.hThread && !CloseHandle(child.hThread)) cleanupOk = FALSE;
  if (child.hProcess && !CloseHandle(child.hProcess)) cleanupOk = FALSE;
  if (job && !CloseHandle(job)) cleanupOk = FALSE;
  if (restrictedToken && !CloseHandle(restrictedToken)) cleanupOk = FALSE;
  if (original && !CloseHandle(original)) cleanupOk = FALSE;
  free(groups); free(childUser); free(logon); free(childLogon);
  if (!cleanupOk) { free(user); return failure("primary child cleanup unconfirmed", ERROR_BUSY, FALSE); }
  if (error != ERROR_SUCCESS) { free(user); return failure(operation, error, blocked); }
  printf("{\"complete\":true,\"pid\":%lu,\"userSid\":", (unsigned long)childPid); hex(user->User.Sid, GetLengthSid(user->User.Sid));
  printf(",\"restricted\":%s,\"tokenType\":%u,\"restrictedSidCount\":%lu,\"sameUser\":%s,\"threadTokenAbsent\":%s,\"threadTokenError\":%lu,"
    "\"exitCode\":%lu,\"processExited\":%s,\"jobEmpty\":%s,\"handlesInherited\":false,\"fixtureAdjustedPrivileges\":false,\"logonSidPreserved\":true}\n",
    json_boolean(tokenRestricted), (unsigned)type, (unsigned long)restrictedCount, json_boolean(sameUser), json_boolean(threadAbsent),
    (unsigned long)threadError, (unsigned long)exitCode, json_boolean(exited), json_boolean(jobEmpty));
  free(user); return 0;
}

int wmain(int argc, wchar_t **argv) {
  if (argc == 9 && wcscmp(argv[1], L"primary-process") == 0) return primary_process(argc, argv);
  if (argc == 4 && wcscmp(argv[1], L"hold-descriptor") == 0) return hold_descriptor(argv[2], argv[3]);
  if (argc == 6 && wcscmp(argv[1], L"token-access") == 0) return token_access(argv[2], argv[3], argv[4], argv[5]);
  if (argc == 4 && wcscmp(argv[1], L"hold-reader") == 0) {
    if (wcscmp(argv[3], L"share-delete") != 0 && wcscmp(argv[3], L"deny-delete") != 0) return failure("hold-reader-sharing", ERROR_INVALID_PARAMETER, FALSE);
    return hold_reader(argv[2], wcscmp(argv[3], L"share-delete") == 0);
  }
  if (argc == 2 && wcscmp(argv[1], L"abi") == 0) return abi();
  if (argc == 2 && wcscmp(argv[1], L"token") == 0) return token_facts();
  if (argc == 3 && wcscmp(argv[1], L"inspect") == 0) return inspect(argv[2], FALSE);
  if (argc == 3 && wcscmp(argv[1], L"descriptor") == 0) return inspect(argv[2], TRUE);
  if (argc == 5 && wcscmp(argv[1], L"create") == 0) {
    if (wcscmp(argv[3], L"file") != 0 && wcscmp(argv[3], L"directory") != 0) return failure("fixture-kind", ERROR_INVALID_PARAMETER, FALSE);
    return create_fixture(argv[2], wcscmp(argv[3], L"directory") == 0, argv[4], NULL);
  }
  if (argc == 4 && wcscmp(argv[1], L"hardlink") == 0) {
    if (!CreateHardLinkW(argv[2], argv[3], NULL)) { DWORD error = GetLastError(); return failure("CreateHardLinkW", error, unavailable(error)); }
    printf("{\"complete\":true,\"created\":true}\n"); return 0;
  }
  if (argc == 5 && wcscmp(argv[1], L"symlink") == 0) {
    DWORD flags = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
    if (wcscmp(argv[4], L"directory") == 0) flags |= SYMBOLIC_LINK_FLAG_DIRECTORY;
    else if (wcscmp(argv[4], L"file") != 0) return failure("fixture-kind", ERROR_INVALID_PARAMETER, FALSE);
    if (!CreateSymbolicLinkW(argv[2], argv[3], flags)) { DWORD error = GetLastError(); return failure("CreateSymbolicLinkW", error, unavailable(error)); }
    printf("{\"complete\":true,\"created\":true}\n"); return 0;
  }
  return failure("usage: abi | token | inspect PATH | create PATH file/directory POLICY | hardlink NEW TARGET | symlink NEW TARGET file/directory", ERROR_INVALID_PARAMETER, FALSE);
}
