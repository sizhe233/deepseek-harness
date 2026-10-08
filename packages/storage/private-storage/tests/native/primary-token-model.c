/* Synthetic SDK responses exercise extracted oracle code, never Windows ABI or token execution. */
#include <assert.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

typedef int BOOL;
typedef uint32_t DWORD;
typedef uint64_t ULONGLONG;
typedef unsigned char BYTE;
typedef uintptr_t HANDLE;
typedef void *PSID;
typedef enum { TokenPrimary = 1, TokenImpersonation = 2 } TOKEN_TYPE;
typedef struct { PSID Sid; DWORD Attributes; } SID_AND_ATTRIBUTES;
typedef struct { SID_AND_ATTRIBUTES User; } TOKEN_USER;
typedef struct { DWORD GroupCount; SID_AND_ATTRIBUTES Groups[6]; } TOKEN_GROUPS;
typedef struct { DWORD cb; } STARTUPINFOW;
typedef struct { HANDLE hProcess, hThread; DWORD dwProcessId; } PROCESS_INFORMATION;
typedef struct { struct { DWORD LimitFlags; } BasicLimitInformation; } JOBOBJECT_EXTENDED_LIMIT_INFORMATION;
typedef struct { DWORD ActiveProcesses; } JOBOBJECT_BASIC_ACCOUNTING_INFORMATION;

#undef NULL
#define NULL 0
#define TRUE 1
#define FALSE 0
#define ERROR_SUCCESS 0
#define ERROR_OUTOFMEMORY 14
#define SE_GROUP_ENABLED 4
#define SE_GROUP_USE_FOR_DENY_ONLY 16
#define ERROR_INVALID_FUNCTION 1
#define ERROR_ACCESS_DENIED 5
#define ERROR_BAD_LENGTH 24
#define ERROR_NOT_SUPPORTED 50
#define ERROR_INVALID_PARAMETER 87
#define ERROR_CALL_NOT_IMPLEMENTED 120
#define ERROR_BUSY 170
#define ERROR_NO_TOKEN 1008
#define ERROR_BAD_TOKEN_TYPE 1349
#define ERROR_BAD_IMPERSONATION_LEVEL 1346
#define ERROR_PRIVILEGE_NOT_HELD 1314
#define ERROR_TIMEOUT 1460
#define STILL_ACTIVE 259
#define WAIT_OBJECT_0 0
#define WAIT_TIMEOUT 258
#define WAIT_FAILED ((DWORD)-1)
#define TOKEN_QUERY 8
#define TOKEN_DUPLICATE 2
#define TOKEN_ASSIGN_PRIMARY 1
#define DISABLE_MAX_PRIVILEGE 1
#define SE_GROUP_LOGON_ID 0xc0000000u
#define SECURITY_MAX_SID_SIZE 68
#define CREATE_SUSPENDED 4
#define CREATE_NO_WINDOW 0x08000000
#define JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE 0x2000
#define ZeroMemory(pointer, length) memset(pointer, 0, length)
enum { TokenUser, TokenGroups, TokenRestrictedSids, TokenLogonSid, TokenType, WinWorldSid, JobObjectExtendedLimitInformation, JobObjectBasicAccountingInformation };
enum { ORIGINAL = 1, RESTRICTED, JOB, PROCESS, THREAD, CHILD_TOKEN, THREAD_TOKEN, CURRENT_PROCESS = 100, CURRENT_THREAD };
enum { CREATE, ASSIGN, CHILD_FACTS, RESUME, WAIT, EXIT, TERMINATE, TERMINATE_JOB, JOB_EMPTY, CLOSE, MAX_EVENTS = 1024 };

static const char *scenario;
static BOOL restricted_mode, assigned, resumed, terminated, live[8];
static unsigned closes[8], events[MAX_EVENTS], event_count, queries, waits, created, failures, allocations, releases;
static DWORD last_error = ERROR_ACCESS_DENIED, failure_error;
static BOOL failure_blocked;
static const char *failure_operation;
static ULONGLONG tick;
static void *owned_allocations[8];
static SID_AND_ATTRIBUTES restricting_sids[6];
static DWORD captured_restriction_count;

static BOOL is(const char *name) { return strcmp(scenario, name) == 0; }
static void event(unsigned value) { assert(event_count < MAX_EVENTS); events[event_count++] = value; }
static unsigned event_index(unsigned value) {
  for (unsigned i = 0; i < event_count; i++) if (events[i] == value) return i;
  return MAX_EVENTS;
}
static HANDLE acquire(unsigned value) { assert(value < 8 && !live[value]); live[value] = TRUE; return value; }
static DWORD GetLastError(void) { return last_error; }
static HANDLE GetCurrentProcess(void) { return CURRENT_PROCESS; }
static HANDLE GetCurrentThread(void) { return CURRENT_THREAD; }
static BOOL OpenThreadToken(HANDLE thread, DWORD access, BOOL self, HANDLE *token) {
  assert(access == TOKEN_QUERY && self);
  assert(thread == CURRENT_THREAD || thread == THREAD);
  if ((thread == CURRENT_THREAD && is("caller-impersonation")) || (thread == THREAD && is("child-thread-present"))) {
    *token = acquire(THREAD_TOKEN); return TRUE;
  }
  last_error = is(thread == CURRENT_THREAD ? "caller-thread-error" : "child-thread-error") ? ERROR_ACCESS_DENIED : ERROR_NO_TOKEN;
  return FALSE;
}
static BOOL OpenProcessToken(HANDLE process, DWORD access, HANDLE *token) {
  if (process == CURRENT_PROCESS) {
    assert(access == (TOKEN_QUERY | TOKEN_DUPLICATE | TOKEN_ASSIGN_PRIMARY));
    if (is("original-open-failure")) { last_error = ERROR_ACCESS_DENIED; return FALSE; }
    *token = acquire(ORIGINAL);
  } else {
    assert(process == PROCESS && assigned && !resumed && access == TOKEN_QUERY);
    event(CHILD_FACTS);
    if (is("child-token-failure")) { last_error = ERROR_ACCESS_DENIED; return FALSE; }
    *token = acquire(CHILD_TOKEN);
  }
  return TRUE;
}
static void *token_information(HANDLE token, unsigned kind) {
  assert(live[token]);
  if ((token == ORIGINAL && is("original-user-failure")) || (token == CHILD_TOKEN &&
    is(kind == TokenUser ? "child-user-failure" : "child-groups-failure"))) { last_error = ERROR_ACCESS_DENIED; return NULL; }
  if (kind == TokenLogonSid && is(token == ORIGINAL ? "original-logon-failure" : "child-logon-failure")) return NULL;
  if (kind == TokenGroups && is("caller-groups-unavailable")) return NULL;
  assert(kind == TokenUser || kind == TokenGroups || kind == TokenRestrictedSids || kind == TokenLogonSid);
  void *value = calloc(1, kind == TokenUser ? sizeof(TOKEN_USER) : sizeof(TOKEN_GROUPS));
  assert(value != NULL && allocations < 8); owned_allocations[allocations++] = value;
  if (kind == TokenUser) ((TOKEN_USER *)value)->User.Sid = (void *)(uintptr_t)(token == CHILD_TOKEN && is("child-wrong-user") ? 2 : 1);
  else if (kind == TokenLogonSid) {
    TOKEN_GROUPS *logon = value;
    logon->GroupCount = is("logon-count") ? 0 : 1;
    logon->Groups[0].Sid = (void *)(uintptr_t)(token == CHILD_TOKEN && is("child-logon-mismatch") ? 4 : 3);
    logon->Groups[0].Attributes = is("logon-attributes") ? 0 : SE_GROUP_LOGON_ID;
  } else if (kind == TokenGroups) {
    TOKEN_GROUPS *groups = value;
    groups->GroupCount = is("caller-groups-overlimit") ? 4097 : 6;
    for (unsigned i = 0; i < 6; i++) { groups->Groups[i].Sid = (void *)(uintptr_t)(i + 1); groups->Groups[i].Attributes = SE_GROUP_ENABLED; }
    groups->Groups[4].Attributes |= SE_GROUP_USE_FOR_DENY_ONLY;
    groups->Groups[5].Attributes = 0;
  } else {
    TOKEN_GROUPS *groups = value;
    groups->GroupCount = is("child-restrict-count") ? 1 : restricted_mode ? captured_restriction_count : 0;
    memcpy(groups->Groups, restricting_sids, sizeof(restricting_sids));
    if (is("child-restricting-sid-mismatch")) groups->Groups[2].Sid = (void *)(uintptr_t)4;
  }
  return value;
}
static void model_free(void *value) {
  if (value == NULL) return;
  unsigned i;
  for (i = 0; i < allocations; i++) if (owned_allocations[i] == value) break;
  assert(i < allocations); owned_allocations[i] = NULL; releases++; free(value);
}
static BOOL IsTokenRestricted(HANDLE token) {
  assert(live[token]);
  return token == ORIGINAL ? is("original-restricted") : is("child-restriction-mismatch") ? !restricted_mode : restricted_mode;
}
static BOOL CreateWellKnownSid(unsigned kind, PSID domain, BYTE *sid, DWORD *size) {
  assert(kind == WinWorldSid && domain == NULL && sid != NULL && *size == SECURITY_MAX_SID_SIZE);
  *size = 12; return !is("world-sid-failure");
}
static BOOL CreateRestrictedToken(HANDLE token, DWORD flags, DWORD disable_count, void *disable,
    DWORD privilege_count, void *privileges, DWORD restrict_count, SID_AND_ATTRIBUTES *restrictions, HANDLE *result) {
  assert(token == ORIGINAL && live[token] && flags == DISABLE_MAX_PRIVILEGE);
  assert(disable_count == 0 && disable == NULL && privilege_count == 0 && privileges == NULL);
  BOOL variant = strncmp(scenario, "caller-groups", 13) == 0;
  assert(restrict_count == (variant ? 4u : 3u) && restrictions[0].Sid == (void *)(uintptr_t)1 && restrictions[1].Sid != NULL);
  if (variant) for (unsigned i = 0; i < restrict_count; i++) assert(restrictions[i].Sid == (void *)(uintptr_t)(i + 1));
  captured_restriction_count = restrict_count;
  assert(restrictions[0].Attributes == 0 && restrictions[1].Attributes == 0 && restrictions[2].Attributes == 0);
  assert(restrictions[2].Sid == (void *)(uintptr_t)3);
  memcpy(restricting_sids, restrictions, restrict_count * sizeof(*restrictions));
  if (is("restrict-failure")) { last_error = ERROR_ACCESS_DENIED; return FALSE; }
  *result = acquire(RESTRICTED); return TRUE;
}
static HANDLE CreateJobObjectW(void *security, const wchar_t *name) {
  assert(security == NULL && name == NULL);
  return is("job-create-failure") ? NULL : acquire(JOB);
}
static BOOL SetInformationJobObject(HANDLE job, unsigned kind, JOBOBJECT_EXTENDED_LIMIT_INFORMATION *limits, DWORD size) {
  assert(job == JOB && live[job] && kind == JobObjectExtendedLimitInformation && size == sizeof(*limits));
  assert(limits->BasicLimitInformation.LimitFlags == JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE);
  return !is("job-config-failure");
}
static BOOL create_process(HANDLE token, const wchar_t *application, wchar_t *command, void *process_security,
    void *thread_security, BOOL inherit, DWORD flags, void *environment, const wchar_t *directory,
    STARTUPINFOW *startup, PROCESS_INFORMATION *child) {
  assert(token == (restricted_mode ? RESTRICTED : NULL) && (!token || live[token]));
  assert(wcscmp(application, L"C:\\Program Files\\node.exe") == 0);
  assert(wcscmp(command, L"\"C:\\Program Files\\node.exe\" \"script.js\" \"entry.js\" \"root\" \"result\" \"ordinary\"") == 0
    || wcscmp(command, L"\"C:\\Program Files\\node.exe\" \"script.js\" \"entry.js\" \"root\" \"result\" \"restricted\"") == 0);
  assert(process_security == NULL && thread_security == NULL && !inherit);
  assert(flags == (CREATE_SUSPENDED | CREATE_NO_WINDOW) && environment == NULL && directory == NULL);
  assert(startup->cb == sizeof(*startup) && live[JOB]); event(CREATE);
  if (is("create-failure")) { last_error = ERROR_ACCESS_DENIED; return FALSE; }
  child->hProcess = acquire(PROCESS); child->hThread = acquire(THREAD); child->dwProcessId = 42; created++; return TRUE;
}
static BOOL CreateProcessAsUserW(HANDLE token, const wchar_t *application, wchar_t *command, void *ps, void *ts,
    BOOL inherit, DWORD flags, void *environment, const wchar_t *directory, STARTUPINFOW *startup, PROCESS_INFORMATION *child) {
  return create_process(token, application, command, ps, ts, inherit, flags, environment, directory, startup, child);
}
static BOOL CreateProcessW(const wchar_t *application, wchar_t *command, void *ps, void *ts,
    BOOL inherit, DWORD flags, void *environment, const wchar_t *directory, STARTUPINFOW *startup, PROCESS_INFORMATION *child) {
  return create_process(NULL, application, command, ps, ts, inherit, flags, environment, directory, startup, child);
}
static BOOL AssignProcessToJobObject(HANDLE job, HANDLE process) {
  assert(job == JOB && process == PROCESS && live[job] && live[process] && !resumed); event(ASSIGN);
  if (is("assign-failure")) return FALSE;
  assigned = TRUE; return TRUE;
}
static BOOL GetTokenInformation(HANDLE token, unsigned kind, TOKEN_TYPE *type, DWORD size, DWORD *bytes) {
  assert(token == CHILD_TOKEN && kind == TokenType && size == sizeof(*type));
  *bytes = size; *type = is("child-impersonation-type") ? TokenImpersonation : TokenPrimary;
  return !is("child-type-query-failure");
}
static BOOL EqualSid(PSID first, PSID second) { return first == second; }
static DWORD ResumeThread(HANDLE thread) {
  assert(thread == THREAD && assigned && live[CHILD_TOKEN]); event(RESUME);
  if (is("resume-failure")) return (DWORD)-1;
  resumed = TRUE; return 1;
}
static DWORD WaitForSingleObject(HANDLE process, DWORD milliseconds) {
  assert(process == PROCESS && live[process]); waits++; event(WAIT);
  if (milliseconds == 5000) { assert(terminated); return is("terminate-wait-failure") ? WAIT_TIMEOUT : WAIT_OBJECT_0; }
  assert(milliseconds == 15000 && resumed);
  if (is("wait-failure")) { last_error = ERROR_ACCESS_DENIED; return WAIT_FAILED; }
  if (is("wait-timeout") || is("terminate-process-failure") || is("terminate-wait-failure")) return WAIT_TIMEOUT;
  return WAIT_OBJECT_0;
}
static BOOL GetExitCodeProcess(HANDLE process, DWORD *result) {
  assert(process == PROCESS && waits == 1); event(EXIT); *result = 0; return !is("exit-query-failure");
}
static BOOL TerminateProcess(HANDLE process, unsigned code) {
  assert(process == PROCESS && live[process] && code == 87); event(TERMINATE);
  if (is("terminate-process-failure")) return FALSE;
  terminated = TRUE; return TRUE;
}
static BOOL TerminateJobObject(HANDLE job, unsigned code) {
  assert(job == JOB && live[job] && code == 87); event(TERMINATE_JOB); return !is("terminate-job-failure");
}
static ULONGLONG GetTickCount64(void) { return tick; }
static void Sleep(unsigned milliseconds) { assert(milliseconds == 10); tick += milliseconds; }
static BOOL QueryInformationJobObject(HANDLE job, unsigned kind, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION *accounting, DWORD size, void *returned) {
  assert(job == JOB && live[job] && kind == JobObjectBasicAccountingInformation && size == sizeof(*accounting) && returned == NULL);
  assert(event_index(TERMINATE_JOB) != MAX_EVENTS); queries++; assert(queries <= 500);
  if (is("job-query-failure")) return FALSE;
  accounting->ActiveProcesses = is("job-never-empty") || (is("job-delayed-empty") && queries < 3) ? 1 : 0;
  if (accounting->ActiveProcesses == 0) event(JOB_EMPTY);
  return TRUE;
}
static BOOL CloseHandle(HANDLE handle) {
  const char *names[] = { "", "close-original-failure", "close-restricted-failure", "close-job-failure",
    "close-process-failure", "close-thread-failure", "close-child-token-failure", "close-thread-token-failure" };
  assert(handle > 0 && handle < 8 && live[handle] && closes[handle] == 0);
  assert(handle != PROCESS || event_index(TERMINATE_JOB) != MAX_EVENTS);
  live[handle] = FALSE; closes[handle]++; event(CLOSE); return !is(names[handle]);
}
static DWORD GetLengthSid(PSID sid) { assert(sid != NULL); return 1; }
static void hex(const void *data, size_t size) { assert(data != NULL && size == 1); fputs("\"01\"", stdout); }
static const char *json_boolean(BOOL value) { return value ? "true" : "false"; }
static int failure(const char *operation, DWORD error, BOOL blocked) {
  failures++; failure_operation = operation; failure_error = error; failure_blocked = blocked; return blocked ? 3 : 1;
}

static void *model_calloc(size_t count, size_t bytes) {
  if (is("caller-groups-allocation-failure")) return NULL;
  void *value = calloc(count, bytes); assert(value != NULL && allocations < 8); owned_allocations[allocations++] = value; return value;
}
#define calloc model_calloc
#define free model_free
#include "primary-process-source.inc"
#undef free
#undef calloc

static void quoting(void) {
  const struct { const wchar_t *input, *quoted; } cases[] = {
    { L"", L"\"\"" }, { L"one", L"\"one\"" }, { L"one two", L"\"one two\"" },
    { L"a\"b", L"\"a\\\"b\"" }, { L"end\\", L"\"end\\\\\"" },
    { L"a\\b", L"\"a\\b\"" }, { L"a\\\"b", L"\"a\\\\\\\"b\"" },
    { L"two\\\\", L"\"two\\\\\\\\\"" }, { L"雪", L"\"雪\"" },
  };
  for (size_t i = 0; i < sizeof(cases) / sizeof(cases[0]); i++) {
    size_t length = wcslen(cases[i].quoted), used = 0;
    wchar_t command[128];
    assert(primary_append_argument(command, 128, &used, cases[i].input));
    assert(wcscmp(command, cases[i].quoted) == 0 && used == length);
    assert(primary_append_argument(command, 128, &used, L"next"));
    assert(wcsncmp(command, cases[i].quoted, length) == 0 && wcscmp(command + length, L" \"next\"") == 0);
    for (size_t capacity = 1; capacity <= length + 2; capacity++) {
      for (size_t j = 0; j < 128; j++) command[j] = L'!';
      used = 0;
      BOOL result = primary_append_argument(command, capacity, &used, cases[i].input);
      assert(result == (capacity >= length + 1));
      assert(command[capacity] == L'!' && used < capacity);
      if (result) assert(wcscmp(command, cases[i].quoted) == 0);
    }
  }
}

int main(int argc, char **argv) {
  assert(argc == 2); scenario = argv[1]; restricted_mode = !is("ordinary");
  if (is("quoting")) quoting();
  else {
    wchar_t *args[] = { L"oracle", L"primary-process", strncmp(scenario, "caller-groups", 13) == 0 ? L"restricted-caller-groups" : restricted_mode ? L"restricted" : L"ordinary",
      L"C:\\Program Files\\node.exe", L"script.js", L"entry.js", L"root", L"result", restricted_mode ? L"restricted" : L"ordinary" };
    int result = primary_process(9, args);
    BOOL success = is("ordinary") || is("restricted") || is("job-delayed-empty") || is("caller-groups");
    assert((result == 0) == success && failures == (success ? 0u : 1u));
    assert(allocations == releases);
    for (unsigned i = 1; i < 8; i++) assert(!live[i] && closes[i] <= 1);
    if (success) {
      assert(created == 1 && assigned && resumed);
      assert(event_index(CREATE) < event_index(ASSIGN) && event_index(ASSIGN) < event_index(CHILD_FACTS));
      assert(event_index(CHILD_FACTS) < event_index(RESUME) && event_index(RESUME) < event_index(WAIT));
      assert(event_index(WAIT) < event_index(EXIT) && event_index(EXIT) < event_index(TERMINATE_JOB));
      assert(event_index(TERMINATE_JOB) < event_index(JOB_EMPTY) && event_index(JOB_EMPTY) < event_index(CLOSE));
    } else {
      assert(failure_operation != NULL && failure_error != ERROR_SUCCESS);
      if (is("original-open-failure") || is("restrict-failure") || is("create-failure")) assert(failure_blocked && result == 3);
      if (strncmp(scenario, "close-", 6) == 0 || strncmp(scenario, "terminate-", 10) == 0 || strncmp(scenario, "job-query-", 10) == 0 || is("job-never-empty"))
        assert(strcmp(failure_operation, "primary child cleanup unconfirmed") == 0 && result == 1);
      if (created && event_index(EXIT) == MAX_EVENTS) assert(event_index(TERMINATE) != MAX_EVENTS);
      if (event_index(RESUME) == MAX_EVENTS) assert(!resumed);
    }
    if (is("job-never-empty")) assert(queries == 500 && tick == 5000);
    if (is("job-delayed-empty")) assert(queries == 3 && tick == 20);
  }
  printf("{\"evidence\":\"synthetic-primary-process-model\",\"nativeExecution\":false,\"scenario\":\"%s\",\"passed\":true}\n", scenario);
  return 0;
}
