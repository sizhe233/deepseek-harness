/* Synthetic declarations for Linux C ownership models only. Never Windows SDK evidence. */
#ifndef OWNER_WINDOWS_MODEL_H
#define OWNER_WINDOWS_MODEL_H
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <wchar.h>
#define WINAPI
#define NTAPI
#define CALLBACK
#define TRUE 1
#define FALSE 0
#define INVALID_HANDLE_VALUE ((HANDLE)(intptr_t)-1)
#define ERROR_SUCCESS 0
#define ERROR_FILE_NOT_FOUND 2
#define ERROR_PATH_NOT_FOUND 3
#define ERROR_ACCESS_DENIED 5
#define ERROR_SHARING_VIOLATION 32
#define ERROR_LOCK_VIOLATION 33
#define ERROR_FILE_EXISTS 80
#define ERROR_INSUFFICIENT_BUFFER 122
#define ERROR_ALREADY_EXISTS 183
#define ERROR_IO_INCOMPLETE 996
#define ERROR_IO_PENDING 997
#define ERROR_NO_TOKEN 1008
#define WAIT_OBJECT_0 0
#define WAIT_TIMEOUT 258
#define WAIT_FAILED 0xffffffffu
#define PROCESS_QUERY_LIMITED_INFORMATION 0x1000
#define SYNCHRONIZE 0x100000
#define FILE_TYPE_UNKNOWN 0
#define FILE_ATTRIBUTE_NORMAL 0x80
#define TOKEN_QUERY 8
#define SECURITY_DESCRIPTOR_REVISION 1
#define SID_REVISION 1
#define SID_MAX_SUB_AUTHORITIES 15
#define SE_SELF_RELATIVE 0x8000
#define ACL_REVISION 2
#define ACL_REVISION_DS 4
#define OWNER_SECURITY_INFORMATION 1
#define DACL_SECURITY_INFORMATION 4
#define LOCKFILE_FAIL_IMMEDIATELY 1
#define LOCKFILE_EXCLUSIVE_LOCK 2
#define GET_MODULE_HANDLE_EX_FLAG_PIN 1
#define GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS 4
#define INIT_ONCE_STATIC_INIT { 0 }
#define SRWLOCK_INIT { 0 }
typedef void *HANDLE;
typedef HANDLE *PHANDLE;
typedef void *HMODULE;
typedef void *PVOID;
typedef uint32_t DWORD;
typedef struct { DWORD dwLowDateTime; DWORD dwHighDateTime; } FILETIME;
typedef DWORD *LPDWORD;
typedef uint32_t ULONG;
typedef ULONG *PULONG;
typedef uint16_t USHORT;
typedef uint32_t ACCESS_MASK;
typedef int32_t NTSTATUS;
typedef int32_t BOOL;
typedef uint8_t BOOLEAN;
typedef int64_t LONG64;
typedef wchar_t WCHAR;
typedef WCHAR *PWSTR;
typedef const WCHAR *LPCWSTR;
typedef void *PSID;
typedef void *PSECURITY_DESCRIPTOR;
typedef void (*FARPROC)(void);
typedef union {
  struct { DWORD LowPart; int32_t HighPart; };
  int64_t QuadPart;
} LARGE_INTEGER, *PLARGE_INTEGER;
typedef struct {
  union { NTSTATUS Status; PVOID Pointer; };
  uintptr_t Information;
} IO_STATUS_BLOCK, *PIO_STATUS_BLOCK;
typedef struct {
  uintptr_t Internal;
  uintptr_t InternalHigh;
  union { struct { DWORD Offset; DWORD OffsetHigh; }; void *Pointer; };
  HANDLE hEvent;
} OVERLAPPED;
typedef struct { USHORT Length; USHORT MaximumLength; PWSTR Buffer; } UNICODE_STRING, *PUNICODE_STRING;
typedef struct {
  ULONG Length;
  HANDLE RootDirectory;
  PUNICODE_STRING ObjectName;
  ULONG Attributes;
  PVOID SecurityDescriptor;
  PVOID SecurityQualityOfService;
} OBJECT_ATTRIBUTES, *POBJECT_ATTRIBUTES;
typedef struct { uint64_t VolumeSerialNumber; unsigned char FileId[16]; } FILE_ID_INFO;
typedef struct { PSID Sid; DWORD Attributes; } SID_AND_ATTRIBUTES;
typedef struct { SID_AND_ATTRIBUTES User; } TOKEN_USER;
typedef struct {
  uint8_t Revision;
  uint8_t Sbz1;
  uint16_t Control;
  DWORD Owner;
  DWORD Group;
  DWORD Sacl;
  DWORD Dacl;
} SECURITY_DESCRIPTOR_RELATIVE;
typedef struct { uint8_t AclRevision; uint8_t Sbz1; uint16_t AclSize; uint16_t AceCount; uint16_t Sbz2; } ACL;
typedef struct { uint8_t AceType; uint8_t AceFlags; uint16_t AceSize; } ACE_HEADER;
typedef struct { uintptr_t opaque; } INIT_ONCE, *PINIT_ONCE;
typedef struct { uintptr_t opaque; } SRWLOCK;
typedef enum { TokenUser = 1 } TOKEN_INFORMATION_CLASS;
typedef enum { FileIdInfo = 18 } FILE_INFO_BY_HANDLE_CLASS;
typedef enum { SE_FILE_OBJECT = 1 } SE_OBJECT_TYPE;
LONG64 InterlockedIncrement64(volatile LONG64 *);
LONG64 InterlockedDecrement64(volatile LONG64 *);
LONG64 InterlockedCompareExchange64(volatile LONG64 *, LONG64, LONG64);
void AcquireSRWLockExclusive(SRWLOCK *);
void ReleaseSRWLockExclusive(SRWLOCK *);
BOOL CloseHandle(HANDLE);
DWORD GetLastError(void);
void SetLastError(DWORD);
PVOID LocalFree(PVOID);
DWORD WaitForSingleObject(HANDLE, DWORD);
BOOL CancelIoEx(HANDLE, OVERLAPPED *);
HANDLE GetCurrentThread(void);
HANDLE GetCurrentProcess(void);
BOOL OpenThreadToken(HANDLE, DWORD, BOOL, PHANDLE);
BOOL OpenProcessToken(HANDLE, DWORD, PHANDLE);
HANDLE OpenProcess(DWORD, BOOL, DWORD);
DWORD GetProcessId(HANDLE);
BOOL GetProcessTimes(HANDLE, FILETIME *, FILETIME *, FILETIME *, FILETIME *);
BOOL IsTokenRestricted(HANDLE);
BOOL GetTokenInformation(HANDLE, TOKEN_INFORMATION_CLASS, PVOID, DWORD, LPDWORD);
BOOL IsValidSid(PSID);
BOOL IsValidSecurityDescriptor(PSECURITY_DESCRIPTOR);
DWORD GetFileType(HANDLE);
BOOL GetFileInformationByHandleEx(HANDLE, FILE_INFO_BY_HANDLE_CLASS, PVOID, DWORD);
BOOL DeviceIoControl(HANDLE, DWORD, PVOID, DWORD, PVOID, DWORD, DWORD *, OVERLAPPED *);
BOOL GetVolumeInformationByHandleW(HANDLE, PWSTR, DWORD, LPDWORD, LPDWORD, LPDWORD, PWSTR, DWORD);
DWORD GetSecurityInfo(HANDLE, SE_OBJECT_TYPE, DWORD, PSID *, PSID *, PVOID *, PVOID *, PSECURITY_DESCRIPTOR *);
DWORD GetSecurityDescriptorLength(PSECURITY_DESCRIPTOR);
BOOL FlushFileBuffers(HANDLE);
BOOL GetOverlappedResult(HANDLE, OVERLAPPED *, LPDWORD, BOOL);
BOOL LockFileEx(HANDLE, DWORD, DWORD, DWORD, DWORD, OVERLAPPED *);
BOOL UnlockFileEx(HANDLE, DWORD, DWORD, DWORD, OVERLAPPED *);
HMODULE GetModuleHandleW(LPCWSTR);
FARPROC GetProcAddress(HMODULE, const char *);
BOOL GetModuleHandleExW(DWORD, LPCWSTR, HMODULE *);
BOOL InitOnceExecuteOnce(PINIT_ONCE, BOOL (*)(PINIT_ONCE, PVOID, PVOID *), PVOID, PVOID *);
#endif
