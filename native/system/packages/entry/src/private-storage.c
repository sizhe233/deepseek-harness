/*
 * Node-API v8 retained POSIX directory and regular-file capabilities.
 * Every fd belongs to one environment. Finalization and environment teardown
 * only release resources; namespace changes require an explicit operation.
 */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _FILE_OFFSET_BITS 64
#include <node_api.h>
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <limits.h>
#include <stdbool.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/types.h>
#include <unistd.h>
#ifdef __APPLE__
#include <dlfcn.h>
#include <libproc.h>
#include <sys/acl.h>
#include <sys/mount.h>
#include <sys/sysctl.h>
#else
#include <sys/syscall.h>
#include <sys/vfs.h>
#include <sys/xattr.h>
#endif

#define CHUNK_LIMIT ((size_t)1024 * 1024)
#define RECORD_LIMIT UINT64_C(67108864)
#define OUTPUT_LIMIT UINT64_C(1073741824)
#define DIRECTORY_ENTRY_LIMIT 100000
#define PATH_LIMIT ((size_t)1024 * 1024)
#define DEPTH_LIMIT 256
#ifndef RENAME_NOREPLACE
#define RENAME_NOREPLACE 1
#endif

typedef enum { DIRECTORY, SOURCE, OUTPUT, LEASE, OUTPUT_AUDIT } resource_kind;
typedef enum { SOURCE_POLICY, TRUSTED_ANCESTOR, PRIVATE_POLICY } admission_policy;
typedef enum { UNPUBLISHED, PUBLISHED, INDETERMINATE } publication_state;
typedef struct owner owner;
typedef struct resource resource;

typedef struct {
  const char *name;
  uintmax_t type;
  char fsid[40];
  uintmax_t block_size;
  bool read_only;
  bool source_supported;
  bool destination_supported;
} filesystem_facts;

typedef struct {
  bool supported;
  int entries;
  int default_entries;
} acl_facts;

struct resource {
  owner *owner;
  resource *previous;
  resource *next;
  resource *parent;
  size_t refs;
  int fd;
  resource_kind kind;
  admission_policy policy;
  struct stat admitted;
  char *name;
  char *staging_name;
  publication_state publication;
  bool failed;
  bool removed;
  bool created;
  bool creation_directory_sync;
  bool creation_parent_sync;
  bool rename_attempted;
  bool file_synced;
  bool file_full_synced;
  bool directory_synced;
  bool eof_observed;
  bool lease_held;
  bool replacement_target_known;
  struct stat replacement_target;
  bool replacement_after_known;
  struct stat replacement_after;
  uint64_t bytes_read;
  uint64_t bytes_written;
};

struct owner {
  napi_env env;
  resource *resources;
  size_t refs;
  bool closing;
};

typedef struct {
  owner *owner;
  resource *resource;
} capability;

typedef struct {
  const char *kind;
  bool entry_created;
  bool creation_uncertain;
  bool facts_known;
  struct stat facts;
  bool binding_verified;
  bool release_attempted;
  int release_error;
  bool directory_synced;
  bool parent_synced;
} creation_observations;

typedef struct {
  int number;
  const char *syscall;
  const char *message;
  creation_observations *creation;
  int cleanup_error;
} failure;

static const napi_type_tag capability_tag = {
    UINT64_C(0x996d7e3f8c6012a1), UINT64_C(0x8e43db7bbde18922)};

static void check(napi_status status) {
  if (status != napi_ok) {
    napi_fatal_error("private-storage", NAPI_AUTO_LENGTH,
                     "Node-API result construction failed", NAPI_AUTO_LENGTH);
  }
}

static napi_value object(napi_env env) {
  napi_value result;
  check(napi_create_object(env, &result));
  return result;
}

static void property(napi_env env, napi_value object, const char *key,
                     napi_value value) {
  check(napi_set_named_property(env, object, key, value));
}

static napi_value string(napi_env env, const char *value) {
  napi_value result;
  check(napi_create_string_utf8(env, value, NAPI_AUTO_LENGTH, &result));
  return result;
}

static void text_property(napi_env env, napi_value object, const char *key,
                          const char *value) {
  property(env, object, key, string(env, value));
}

static void boolean_property(napi_env env, napi_value object, const char *key,
                             bool value) {
  napi_value result;
  check(napi_get_boolean(env, value, &result));
  property(env, object, key, result);
}

static void number_property(napi_env env, napi_value object, const char *key,
                            double value) {
  napi_value result;
  check(napi_create_double(env, value, &result));
  property(env, object, key, result);
}

static void unsigned_property(napi_env env, napi_value object, const char *key,
                              uintmax_t value) {
  char buffer[64];
  (void)snprintf(buffer, sizeof(buffer), "%" PRIuMAX, value);
  text_property(env, object, key, buffer);
}

static void signed_property(napi_env env, napi_value object, const char *key,
                            intmax_t value) {
  char buffer[64];
  (void)snprintf(buffer, sizeof(buffer), "%" PRIdMAX, value);
  text_property(env, object, key, buffer);
}

/* Decimal arithmetic preserves times beyond the int64 nanosecond range. */
static void time_property(napi_env env, napi_value object, const char *key,
                          time_t seconds, long nanoseconds) {
  char buffer[96];
  intmax_t sec = (intmax_t)seconds;
  if (sec >= 0) {
    if (sec == 0) (void)snprintf(buffer, sizeof(buffer), "%ld", nanoseconds);
    else (void)snprintf(buffer, sizeof(buffer), "%" PRIdMAX "%09ld", sec, nanoseconds);
  } else if (nanoseconds == 0) {
    (void)snprintf(buffer, sizeof(buffer), "%" PRIdMAX "000000000", sec);
  } else {
    uintmax_t whole = (uintmax_t)(-(sec + 1));
    long remainder = 1000000000L - nanoseconds;
    if (whole == 0) (void)snprintf(buffer, sizeof(buffer), "-%ld", remainder);
    else (void)snprintf(buffer, sizeof(buffer), "-%" PRIuMAX "%09ld", whole, remainder);
  }
  text_property(env, object, key, buffer);
}

#ifdef __APPLE__
#define MTIME(stat) ((stat).st_mtimespec)
#define CTIME(stat) ((stat).st_ctimespec)
#else
#define MTIME(stat) ((stat).st_mtim)
#define CTIME(stat) ((stat).st_ctim)
#endif

static const char *kind_name(mode_t mode) {
  if (S_ISREG(mode)) return "regular";
  if (S_ISDIR(mode)) return "directory";
  if (S_ISLNK(mode)) return "symlink";
  if (S_ISFIFO(mode)) return "fifo";
  if (S_ISSOCK(mode)) return "socket";
  if (S_ISCHR(mode)) return "character";
  if (S_ISBLK(mode)) return "block";
  return "unknown";
}

static napi_value stat_value(napi_env env, const struct stat *stat) {
  napi_value result = object(env);
  text_property(env, result, "kind", kind_name(stat->st_mode));
  unsigned_property(env, result, "dev", (uintmax_t)stat->st_dev);
  unsigned_property(env, result, "ino", (uintmax_t)stat->st_ino);
  unsigned_property(env, result, "uid", (uintmax_t)stat->st_uid);
  unsigned_property(env, result, "gid", (uintmax_t)stat->st_gid);
  number_property(env, result, "mode", (double)stat->st_mode);
  unsigned_property(env, result, "nlink", (uintmax_t)stat->st_nlink);
  signed_property(env, result, "size", (intmax_t)stat->st_size);
  time_property(env, result, "mtimeNs", MTIME(*stat).tv_sec, MTIME(*stat).tv_nsec);
  time_property(env, result, "ctimeNs", CTIME(*stat).tv_sec, CTIME(*stat).tv_nsec);
  return result;
}

static bool fail(failure *error, int number, const char *syscall,
                  const char *message) {
  error->number = number;
  error->syscall = syscall;
  error->message = message;
  return false;
}

static const char *errno_name(int number) {
  switch (number) {
    case EACCES: return "EACCES";
    case EAGAIN: return "EAGAIN";
    case EBADF: return "EBADF";
    case EEXIST: return "EEXIST";
    case EINVAL: return "EINVAL";
    case EIO: return "EIO";
    case EISDIR: return "EISDIR";
    case ELOOP: return "ELOOP";
    case EMFILE: return "EMFILE";
    case ENFILE: return "ENFILE";
    case ENOENT: return "ENOENT";
    case ENOMEM: return "ENOMEM";
    case ENOSPC: return "ENOSPC";
    case ENOSYS: return "ENOSYS";
    case ENOTDIR: return "ENOTDIR";
    case ENOTEMPTY: return "ENOTEMPTY";
    case ENOTSUP: return "ENOTSUP";
    case EPERM: return "EPERM";
    case EROFS: return "EROFS";
    case ESTALE: return "ESTALE";
    case EXDEV: return "EXDEV";
    case EINTR: return "EINTR";
    case EFBIG: return "EFBIG";
    case ENAMETOOLONG: return "ENAMETOOLONG";
    case EOVERFLOW: return "EOVERFLOW";
    case EILSEQ: return "EILSEQ";
    case ESRCH: return "ESRCH";
    default: return "ERR_POSIX_STORAGE";
  }
}

static const char *publication_name(publication_state state) {
  if (state == PUBLISHED) return "published";
  if (state == INDETERMINATE) return "indeterminate";
  return "not-published";
}

static napi_value throw_failure(napi_env env, const failure *error,
                                const resource *resource, uint64_t confirmed) {
  napi_value result;
  check(napi_create_error(env, string(env, errno_name(error->number)),
                          string(env, error->message), &result));
  number_property(env, result, "errno", error->number);
  boolean_property(env, result, "cleanupFailed", error->cleanup_error != 0);
  if (error->cleanup_error != 0) number_property(env, result, "cleanupErrno", error->cleanup_error);
  text_property(env, result, "syscall", error->syscall);
  number_property(env, result, "confirmedBytes", (double)confirmed);
  boolean_property(env, result, "renameAttempted", resource != NULL && resource->rename_attempted);
  const char *publication = resource == NULL ? "not-published" : publication_name(resource->publication);
  if (error->creation != NULL && strcmp(error->creation->kind, "directory") == 0) {
    if (error->creation->entry_created) publication = "published";
    else if (error->creation->creation_uncertain) publication = "indeterminate";
  }
  text_property(env, result, "publicationState", publication);
  if (resource != NULL) {
    unsigned_property(env, result, "totalBytesRead", resource->bytes_read);
    unsigned_property(env, result, "totalBytesWritten", resource->bytes_written);
    boolean_property(env, result, "fileSynced", resource->file_synced);
    boolean_property(env, result, "fileFullSynced", resource->file_full_synced);
    boolean_property(env, result, "directorySynced", resource->directory_synced);
    boolean_property(env, result, "removed", resource->removed);
    if (resource->kind == LEASE) boolean_property(env, result, "leaseHeld", resource->lease_held);
    if (resource->replacement_target_known) property(env, result, "replacedFacts", stat_value(env, &resource->replacement_target));
    if (resource->replacement_after_known) property(env, result, "replacedAfterFacts", stat_value(env, &resource->replacement_after));
  }
  if (error->creation != NULL) {
    const creation_observations *observations = error->creation;
    napi_value creation = object(env);
    napi_value null_value;
    check(napi_get_null(env, &null_value));
    text_property(env, creation, "kind", observations->kind);
    boolean_property(env, creation, "entryCreated", observations->entry_created);
    text_property(env, creation, "entryCreationState", observations->entry_created ? "created" : observations->creation_uncertain ? "indeterminate" : "not-created");
    property(env, creation, "facts", observations->facts_known ? stat_value(env, &observations->facts) : null_value);
    boolean_property(env, creation, "bindingVerified", observations->binding_verified);
    napi_value release = object(env);
    boolean_property(env, release, "attempted", observations->release_attempted);
    boolean_property(env, release, "completed", observations->release_attempted && observations->release_error == 0);
    if (observations->release_error == 0) property(env, release, "errno", null_value);
    else number_property(env, release, "errno", observations->release_error);
    property(env, creation, "release", release);
    napi_value creation_sync = object(env);
    boolean_property(env, creation_sync, "directory", observations->directory_synced);
    boolean_property(env, creation_sync, "parent", observations->parent_synced);
    property(env, creation, "creationSync", creation_sync);
    napi_value cleanup = object(env);
    boolean_property(env, cleanup, "attempted", false);
    boolean_property(env, cleanup, "removed", false);
    boolean_property(env, cleanup, "directorySynced", false);
    property(env, creation, "cleanup", cleanup);
    property(env, result, "creation", creation);
  }
  check(napi_throw(env, result));
  return NULL;
}

static napi_value invalid(napi_env env, const char *message) {
  check(napi_throw_type_error(env, "ERR_INVALID_ARG_VALUE", message));
  return NULL;
}

static void owner_release(owner *state) {
  if (--state->refs == 0) free(state);
}

static void observe_release(failure *error, int number) {
  if (error->cleanup_error == 0) error->cleanup_error = number;
  if (error->creation == NULL) return;
  error->creation->release_attempted = true;
  if (error->creation->release_error == 0) error->creation->release_error = number;
}

static int release_fd(resource *resource) {
  int fd = resource->fd;
  resource->fd = -1;
  resource->lease_held = false;
  /* EINTR does not authorize retrying a possibly reused descriptor number. */
  return fd < 0 || close(fd) == 0 ? 0 : errno;
}

static int release_resource(resource *resource) {
  if (--resource->refs != 0) return 0;
  owner *state = resource->owner;
  if (resource->previous != NULL) resource->previous->next = resource->next;
  else state->resources = resource->next;
  if (resource->next != NULL) resource->next->previous = resource->previous;
  int error = release_fd(resource);
  struct resource *parent = resource->parent;
  free(resource->name);
  free(resource->staging_name);
  free(resource);
  if (parent != NULL) {
    int parent_error = release_resource(parent);
    if (error == 0) error = parent_error;
  }
  return error;
}

static void cleanup_environment(void *data) {
  owner *state = data;
  state->closing = true;
  for (resource *item = state->resources; item != NULL; item = item->next) {
    (void)release_fd(item);
  }
  owner_release(state);
}

static void finalize_capability(napi_env env, void *data, void *hint) {
  (void)env;
  (void)hint;
  capability *cap = data;
  resource *item = cap->resource;
  cap->resource = NULL;
  if (item != NULL) (void)release_resource(item);
  owner_release(cap->owner);
  free(cap);
}

static resource *new_resource(owner *state, int fd, resource_kind kind,
                              admission_policy policy, resource *parent,
                              const char *name, failure *error) {
  resource *item = calloc(1, sizeof(*item));
  if (item == NULL) {
    observe_release(error, close(fd) == 0 ? 0 : errno);
    fail(error, ENOMEM, "calloc", "Cannot allocate a retained resource");
    return NULL;
  }
  item->name = name == NULL ? NULL : strdup(name);
  if (name != NULL && item->name == NULL) {
    free(item);
    observe_release(error, close(fd) == 0 ? 0 : errno);
    fail(error, ENOMEM, "strdup", "Cannot retain a component name");
    return NULL;
  }
  item->owner = state;
  item->fd = fd;
  item->refs = 1;
  item->kind = kind;
  item->policy = policy;
  item->parent = parent;
  if (parent != NULL) ++parent->refs;
  item->next = state->resources;
  if (state->resources != NULL) state->resources->previous = item;
  state->resources = item;
  if (fstat(fd, &item->admitted) != 0) {
    int number = errno;
    observe_release(error, release_resource(item));
    fail(error, number, "fstat", "Cannot inspect an opened resource");
    return NULL;
  }
  if (error->creation != NULL && error->creation->entry_created) {
    error->creation->facts = item->admitted;
    error->creation->facts_known = true;
  }
  return item;
}

static napi_value wrap_resource(napi_env env, owner *state, resource *item) {
  capability *cap = calloc(1, sizeof(*cap));
  if (cap == NULL) {
    creation_observations creation = {
      .kind = item->kind == OUTPUT ? "staging" : item->kind == LEASE ? "lease" : "directory",
      .entry_created = item->created, .facts_known = true, .facts = item->admitted, .binding_verified = true,
      .directory_synced = item->creation_directory_sync, .parent_synced = item->creation_parent_sync,
    };
    failure error = {.number = ENOMEM, .syscall = "calloc", .message = "Cannot allocate a capability",
                     .creation = item->kind == SOURCE || item->kind == OUTPUT_AUDIT ? NULL : &creation};
    resource observations = *item;
    observe_release(&error, release_resource(item));
    if (creation.release_error == 0) observations.lease_held = false;
    return throw_failure(env, &error, &observations, 0);
  }
  cap->owner = state;
  cap->resource = item;
  ++state->refs;
  napi_value result = object(env);
  check(napi_type_tag_object(env, result, &capability_tag));
  check(napi_wrap(env, result, cap, finalize_capability, NULL, NULL));
  check(napi_object_freeze(env, result));
  return result;
}

static capability *get_capability(napi_env env, owner *state, napi_value value,
                                 bool allow_closed) {
  bool tagged = false;
  if (napi_check_object_type_tag(env, value, &capability_tag, &tagged) != napi_ok || !tagged) {
    invalid(env, "Expected a capability from this native environment");
    return NULL;
  }
  capability *cap = NULL;
  if (napi_unwrap(env, value, (void **)&cap) != napi_ok || cap == NULL || cap->owner != state) {
    invalid(env, "Expected a capability from this native environment");
    return NULL;
  }
  if (!allow_closed && (cap->resource == NULL || state->closing || cap->resource->fd < 0)) {
    failure error = {.number = EBADF, .syscall = "capability", .message = "Capability is closed"};
    throw_failure(env, &error, NULL, 0);
    return NULL;
  }
  return cap;
}

static owner *arguments(napi_env env, napi_callback_info info, size_t count,
                        napi_value *values) {
  size_t received = count;
  void *data;
  check(napi_get_cb_info(env, info, &received, values, NULL, &data));
  if (received != count) {
    invalid(env, "Wrong number of arguments");
    return NULL;
  }
  return data;
}

static char *get_string(napi_env env, napi_value value, bool path) {
  napi_valuetype type;
  check(napi_typeof(env, value, &type));
  size_t length = 0;
  if (type != napi_string || napi_get_value_string_utf8(env, value, NULL, 0, &length) != napi_ok ||
      length == 0 || length > (path ? PATH_LIMIT : (size_t)NAME_MAX)) {
    invalid(env, "Expected a bounded nonempty literal path or component");
    return NULL;
  }
  size_t units;
  check(napi_get_value_string_utf16(env, value, NULL, 0, &units));
  char16_t *utf16 = malloc((units + 1) * sizeof(*utf16));
  if (utf16 == NULL) {
    failure error = {.number = ENOMEM, .syscall = "malloc", .message = "Cannot validate a component"};
    throw_failure(env, &error, NULL, 0);
    return NULL;
  }
  check(napi_get_value_string_utf16(env, value, utf16, units + 1, &units));
  bool valid_unicode = true;
  for (size_t index = 0; index < units; ++index) {
    if (utf16[index] >= 0xd800 && utf16[index] <= 0xdbff) {
      if (++index == units || utf16[index] < 0xdc00 || utf16[index] > 0xdfff) { valid_unicode = false; break; }
    } else if (utf16[index] >= 0xdc00 && utf16[index] <= 0xdfff) { valid_unicode = false; break; }
  }
  free(utf16);
  if (!valid_unicode) { invalid(env, "Literal names cannot contain unpaired UTF-16 surrogates"); return NULL; }
  char *buffer = malloc(length + 1);
  if (buffer == NULL) {
    failure error = {.number = ENOMEM, .syscall = "malloc", .message = "Cannot copy a component"};
    throw_failure(env, &error, NULL, 0);
    return NULL;
  }
  size_t copied;
  check(napi_get_value_string_utf8(env, value, buffer, length + 1, &copied));
  if (copied != length || memchr(buffer, '\0', length) != NULL ||
      (!path && (strchr(buffer, '/') != NULL || strcmp(buffer, ".") == 0 || strcmp(buffer, "..") == 0))) {
    free(buffer);
    invalid(env, "Components must be literal names without separators, NUL, dot or dot-dot");
    return NULL;
  }
  return buffer;
}

static bool get_boolean(napi_env env, napi_value value, bool *result) {
  if (napi_get_value_bool(env, value, result) != napi_ok) {
    invalid(env, "Expected a boolean");
    return false;
  }
  return true;
}

static bool same_identity(const struct stat *left, const struct stat *right) {
  return left->st_dev == right->st_dev && left->st_ino == right->st_ino &&
         (left->st_mode & S_IFMT) == (right->st_mode & S_IFMT);
}

static bool same_security(const struct stat *left, const struct stat *right) {
  return left->st_mode == right->st_mode && left->st_uid == right->st_uid && left->st_gid == right->st_gid;
}

static bool same_file(const struct stat *left, const struct stat *right) {
  return same_identity(left, right) && same_security(left, right) &&
         left->st_nlink == right->st_nlink && left->st_size == right->st_size &&
         MTIME(*left).tv_sec == MTIME(*right).tv_sec && MTIME(*left).tv_nsec == MTIME(*right).tv_nsec &&
         CTIME(*left).tv_sec == CTIME(*right).tv_sec && CTIME(*left).tv_nsec == CTIME(*right).tv_nsec;
}

static bool filesystem(int fd, filesystem_facts *facts, failure *error) {
  struct statfs fs;
  struct statvfs vfs;
  if (fstatfs(fd, &fs) != 0) return fail(error, errno, "fstatfs", "Cannot inspect the retained filesystem");
  if (fstatvfs(fd, &vfs) != 0) return fail(error, errno, "fstatvfs", "Cannot inspect filesystem flags");
  memset(facts, 0, sizeof(*facts));
  facts->type = (uintmax_t)(uint32_t)fs.f_type;
  facts->block_size = (uintmax_t)fs.f_bsize;
  facts->read_only = (vfs.f_flag & ST_RDONLY) != 0;
  int32_t fsid[2] = {0, 0};
  memcpy(fsid, &fs.f_fsid, sizeof(fsid));
  (void)snprintf(facts->fsid, sizeof(facts->fsid), "%08" PRIx32 ":%08" PRIx32,
                 (uint32_t)fsid[0], (uint32_t)fsid[1]);
#ifdef __APPLE__
  facts->name = strcmp(fs.f_fstypename, "apfs") == 0 ? "apfs" : "unsupported";
  facts->destination_supported = strcmp(fs.f_fstypename, "apfs") == 0 && (fs.f_flags & MNT_LOCAL) != 0;
  facts->source_supported = facts->destination_supported;
#else
  switch ((uint32_t)fs.f_type) {
    case UINT32_C(0xef53): facts->name = "ext-family"; facts->destination_supported = true; break;
    case UINT32_C(0x58465342): facts->name = "xfs"; facts->destination_supported = true; break;
    case UINT32_C(0x9123683e): facts->name = "btrfs"; facts->destination_supported = true; break;
    case UINT32_C(0x794c7630): facts->name = "overlayfs"; facts->source_supported = true; break;
    case UINT32_C(0x01021994): facts->name = "tmpfs"; facts->source_supported = true; break;
    case UINT32_C(0x73717368): facts->name = "squashfs"; facts->source_supported = true; break;
    case UINT32_C(0xe0f5e1e2): facts->name = "erofs"; facts->source_supported = true; break;
    default: facts->name = "unsupported"; break;
  }
  facts->source_supported = facts->source_supported || facts->destination_supported;
#endif
  return true;
}

#ifndef __APPLE__
static bool linux_acl_count(int fd, const char *name, int *count, bool *supported,
                             failure *error) {
  /* Linux POSIX ACL xattrs are a four-byte header followed by eight-byte entries. */
  ssize_t size = fgetxattr(fd, name, NULL, 0);
  if (size < 0) {
    if (errno == ENODATA) { *count = 0; return true; }
    if (errno == ENOTSUP) { *supported = false; *count = -1; return true; }
    return fail(error, errno, "fgetxattr", "Cannot inspect the retained POSIX ACL");
  }
  if (size < 4 || (size - 4) % 8 != 0 || size > INT_MAX) {
    return fail(error, ENOTSUP, "fgetxattr", "Unsupported POSIX ACL representation");
  }
  *count = (int)((size - 4) / 8);
  return true;
}
#endif

static bool inspect_acl(int fd, bool directory, acl_facts *facts, failure *error) {
  facts->supported = true;
  facts->entries = 0;
  facts->default_entries = 0;
#ifdef __APPLE__
  (void)directory;
  filesec_t security = filesec_init();
  if (security == NULL) return fail(error, errno, "filesec_init", "Cannot allocate retained ACL observations");
  struct stat observed;
  if (fstatx_np(fd, &observed, security) != 0) {
    int number = errno;
    filesec_free(security);
    return fail(error, number, "fstatx_np", "Cannot inspect the retained extended ACL");
  }
  int present = 0;
  if (filesec_query_property(security, FILESEC_ACL, &present) != 0) {
    int number = errno;
    filesec_free(security);
    return fail(error, number, "filesec_query_property", "Cannot determine retained extended ACL presence");
  }
  /* A successful fd observation can have no ACL property; errno alone cannot establish absence. */
  if (!present) { filesec_free(security); return true; }
  acl_t acl = NULL;
  if (filesec_get_property(security, FILESEC_ACL, &acl) != 0) {
    int number = errno;
    filesec_free(security);
    return fail(error, number, "filesec_get_property", "Cannot copy the retained extended ACL");
  }
  filesec_free(security);
  if (acl == NULL) return fail(error, EIO, "filesec_get_property", "Retained extended ACL observation is missing");
  if (acl_valid(acl) != 0) { int number = errno; (void)acl_free(acl); return fail(error, number, "acl_valid", "Unsupported retained extended ACL"); }
  acl_entry_t entry;
  int status = acl_get_entry(acl, ACL_FIRST_ENTRY, &entry);
  /* Darwin returns zero for an entry and EINVAL when enumeration ends. */
  while (status == 0) {
    ++facts->entries;
    status = acl_get_entry(acl, ACL_NEXT_ENTRY, &entry);
  }
  int number = errno;
  (void)acl_free(acl);
  if (status < 0 && number != EINVAL) return fail(error, number, "acl_get_entry", "Cannot enumerate the retained extended ACL");
#else
  if (!linux_acl_count(fd, "system.posix_acl_access", &facts->entries, &facts->supported, error)) return false;
  if (directory && !linux_acl_count(fd, "system.posix_acl_default", &facts->default_entries, &facts->supported, error)) return false;
#endif
  return true;
}

static bool admit(resource *item, const struct stat *stat, failure *error) {
  if (item->kind == DIRECTORY ? !S_ISDIR(stat->st_mode) : !S_ISREG(stat->st_mode)) {
    return fail(error, EINVAL, "fstat", "The retained object has an unsupported type");
  }
  if (item->kind != DIRECTORY && stat->st_size < 0) return fail(error, EINVAL, "fstat", "Negative file size is unsupported");
  filesystem_facts fs;
  acl_facts acl;
  if (!filesystem(item->fd, &fs, error) || !inspect_acl(item->fd, item->kind == DIRECTORY, &acl, error)) return false;
  if (item->policy == SOURCE_POLICY) {
    if (!fs.source_supported) return fail(error, ENOTSUP, "fstatfs", "Filesystem is not admitted for read-only sources");
    return true;
  }
  if (stat->st_uid != geteuid() && (item->policy != TRUSTED_ANCESTOR || stat->st_uid != 0)) {
    return fail(error, EACCES, "fstat", "Directory ownership does not meet the destination policy");
  }
  if (item->policy == TRUSTED_ANCESTOR) {
    if ((stat->st_mode & 0022) != 0 && !((stat->st_mode & S_ISVTX) != 0 && stat->st_uid == 0)) {
      return fail(error, EACCES, "fstat", "Destination ancestor permits untrusted namespace changes");
    }
  } else {
    mode_t permissions = stat->st_mode & 07777;
    if (item->kind == DIRECTORY ? permissions != 0700 : (permissions != 0600 && permissions != 0700)) {
      return fail(error, EACCES, "fstat", "Private destinations require owner-only permissions");
    }
    if (item->kind != DIRECTORY && stat->st_nlink != 1) return fail(error, EACCES, "fstat", "Private output must have exactly one link");
    if (!fs.destination_supported) return fail(error, ENOTSUP, "fstatfs", "Filesystem is not admitted for private destinations");
    if (fs.read_only) return fail(error, EROFS, "fstatvfs", "Private destination filesystem is read-only");
  }
#ifdef __APPLE__
  if (!acl.supported || acl.entries != 0) return fail(error, EACCES, "acl_get_fd_np", "Destination extended ACLs are not admitted");
#endif
  return true;
}

static bool literal_spelling(resource *parent, const char *name, failure *error) {
#ifdef __APPLE__
  int copied = fcntl(parent->fd, F_DUPFD_CLOEXEC, 0);
  if (copied < 0) return fail(error, errno, "fcntl", "Cannot inspect directory component spelling");
  DIR *directory = fdopendir(copied);
  if (directory == NULL) { int number = errno; (void)close(copied); return fail(error, number, "fdopendir", "Cannot inspect directory entries"); }
  rewinddir(directory);
  bool found = false;
  errno = 0;
  struct dirent *entry;
  while ((entry = readdir(directory)) != NULL) {
    if (strcmp(entry->d_name, name) == 0) { found = true; break; }
  }
  int number = errno;
  (void)closedir(directory);
  if (!found) return fail(error, number == 0 ? ESTALE : number, "readdir", "Component spelling does not match a directory entry");
#else
  (void)parent;
  (void)name;
  (void)error;
#endif
  return true;
}

static bool check_binding(resource *item, failure *error) {
  if (item->parent == NULL) return true;
  struct stat binding;
  if (fstatat(item->parent->fd, item->name, &binding, AT_SYMLINK_NOFOLLOW) != 0) {
    return fail(error, errno, "fstatat", "Retained component binding is unavailable");
  }
  if (!same_identity(&item->admitted, &binding)) return fail(error, ESTALE, "fstatat", "Retained component binding changed");
  return literal_spelling(item->parent, item->name, error);
}

static bool validate(resource *item, bool exact_file, failure *error) {
  if (item->fd < 0) return fail(error, EBADF, "capability", "Capability is closed");
  if (item->parent != NULL && !validate(item->parent, false, error)) return false;
  struct stat current;
  if (fstat(item->fd, &current) != 0) return fail(error, errno, "fstat", "Cannot inspect retained object");
  if (!same_identity(&item->admitted, &current) || !same_security(&item->admitted, &current) ||
      (exact_file && !same_file(&item->admitted, &current))) {
    return fail(error, ESTALE, "fstat", "Retained object observations changed");
  }
  return admit(item, &current, error) && check_binding(item, error);
}

static bool ready(resource *item, resource_kind kind, failure *error) {
  if (item->kind != kind) return fail(error, EINVAL, "capability", "Capability does not support this operation");
  if (item->failed || item->removed || (kind == OUTPUT && item->publication != UNPUBLISHED)) {
    return fail(error, EBADF, "capability", "Stream is terminal");
  }
  if (!validate(item, kind != DIRECTORY, error)) { item->failed = kind != DIRECTORY; return false; }
  return true;
}

static bool synchronize(int fd, const char *message, failure *error) {
  int status;
  do { status = fsync(fd); } while (status < 0 && errno == EINTR);
  return status == 0 || fail(error, errno, "fsync", message);
}

static napi_value filesystem_value(napi_env env, const filesystem_facts *fs) {
  napi_value result = object(env);
  text_property(env, result, "name", fs->name);
  unsigned_property(env, result, "type", fs->type);
  text_property(env, result, "fsid", fs->fsid);
  unsigned_property(env, result, "blockSize", fs->block_size);
  boolean_property(env, result, "readOnly", fs->read_only);
  return result;
}

static napi_value facts_value(napi_env env, resource *item, failure *error) {
  struct stat current;
  filesystem_facts fs;
  acl_facts acl;
  if (fstat(item->fd, &current) != 0) { fail(error, errno, "fstat", "Cannot inspect retained object"); return NULL; }
  if (!filesystem(item->fd, &fs, error) || !inspect_acl(item->fd, item->kind == DIRECTORY, &acl, error)) return NULL;
  napi_value result = stat_value(env, &current);
#ifdef __APPLE__
  text_property(env, result, "platform", "darwin");
#else
  text_property(env, result, "platform", "linux");
#endif
  property(env, result, "filesystem", filesystem_value(env, &fs));
  napi_value acl_value = object(env);
#ifdef __APPLE__
  text_property(env, acl_value, "model", "darwin-extended");
#else
  text_property(env, acl_value, "model", "linux-posix-mode-mask");
#endif
  boolean_property(env, acl_value, "supported", acl.supported);
  number_property(env, acl_value, "entries", acl.entries);
  number_property(env, acl_value, "defaultEntries", acl.default_entries);
  property(env, result, "acl", acl_value);
  boolean_property(env, result, "bindingVerified", true);
  boolean_property(env, result, "created", item->created);
  napi_value creation = object(env);
  boolean_property(env, creation, "directory", item->creation_directory_sync);
  boolean_property(env, creation, "parent", item->creation_parent_sync);
  property(env, result, "creationSync", creation);
  unsigned_property(env, result, "bytesRead", item->bytes_read);
  unsigned_property(env, result, "bytesWritten", item->bytes_written);
  boolean_property(env, result, "published", item->publication == PUBLISHED);
  boolean_property(env, result, "removed", item->removed);
  if (item->kind == LEASE) boolean_property(env, result, "leaseHeld", item->lease_held);
  if (item->kind == DIRECTORY && item->parent != NULL) {
    struct stat parent_current;
    if (fstat(item->parent->fd, &parent_current) != 0) {
      fail(error, errno, "fstat", "Cannot inspect the retained directory parent");
      return NULL;
    }
    napi_value binding = object(env);
    text_property(env, binding, "name", item->name);
    property(env, binding, "before", stat_value(env, &item->parent->admitted));
    property(env, binding, "after", stat_value(env, &parent_current));
    property(env, result, "parentBinding", binding);
  }
  return result;
}

static napi_value open_directory(napi_env env, napi_callback_info info) {
  napi_value values[3];
  owner *state = arguments(env, info, 3, values);
  if (state == NULL) return NULL;
  char *path = get_string(env, values[0], true);
  if (path == NULL) return NULL;
  char *policy_name = get_string(env, values[1], false);
  if (policy_name == NULL) { free(path); return NULL; }
  bool create;
  if (!get_boolean(env, values[2], &create)) { free(path); free(policy_name); return NULL; }
  bool private = strcmp(policy_name, "private") == 0;
  bool source = strcmp(policy_name, "source") == 0;
  free(policy_name);
  if ((!private && !source) || (source && create) || path[0] != '/' ||
      (strlen(path) > 1 && path[strlen(path) - 1] == '/')) {
    free(path);
    return invalid(env, "Expected an absolute literal path, source/private policy, and private-only creation");
  }
  size_t depth = 0;
  for (char *cursor = path + 1; *cursor != '\0'; ++cursor) if (*cursor == '/') ++depth;
  if (depth >= DEPTH_LIMIT) { free(path); return invalid(env, "Directory chain is too deep"); }
  creation_observations creation = {.kind = "directory"};
  failure error = {.creation = create ? &creation : NULL};
  int fd = open("/", O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { free(path); fail(&error, errno, "open", "Cannot retain filesystem root"); return throw_failure(env, &error, NULL, 0); }
  resource *current = new_resource(state, fd, DIRECTORY, private ? TRUSTED_ANCESTOR : SOURCE_POLICY, NULL, NULL, &error);
  if (current == NULL) { free(path); return throw_failure(env, &error, NULL, 0); }
  if (!admit(current, &current->admitted, &error)) goto failed;
  char *component = path + 1;
  while (*component != '\0') {
    char *slash = strchr(component, '/');
    bool final = slash == NULL;
    if (slash != NULL) *slash = '\0';
    if (*component == '\0' || strcmp(component, ".") == 0 || strcmp(component, "..") == 0 || strlen(component) > NAME_MAX) {
      fail(&error, EINVAL, "openat", "Directory path contains a nonliteral component");
      goto failed;
    }
    if (!validate(current, false, &error)) goto failed;
    bool created = false;
    fd = openat(current->fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    if (fd < 0 && errno == ENOENT && final && create) {
      filesystem_facts fs;
      if (!filesystem(current->fd, &fs, &error)) goto failed;
      if (!fs.destination_supported || fs.read_only) {
        fail(&error, fs.read_only ? EROFS : ENOTSUP, "fstatfs", "Parent filesystem is not admitted for private creation");
        goto failed;
      }
      creation.creation_uncertain = true;
      if (mkdirat(current->fd, component, 0700) != 0) {
        if (errno == EEXIST) creation.creation_uncertain = false;
        fail(&error, errno, "mkdirat", "Cannot exclusively create the private directory");
        goto failed;
      }
      created = true;
      creation.entry_created = true;
      fd = openat(current->fd, component, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    }
    if (fd < 0) { fail(&error, errno, "openat", "Cannot retain a directory component"); goto failed; }
    resource *next = new_resource(state, fd, DIRECTORY,
        private ? (final ? PRIVATE_POLICY : TRUSTED_ANCESTOR) : SOURCE_POLICY, current, component, &error);
    if (next == NULL) goto failed;
    (void)release_resource(current);
    current = next;
    current->created = created;
    if (!validate(current, false, &error)) goto failed;
    if (created) {
      if (!synchronize(current->fd, "Cannot synchronize the new directory", &error)) goto failed;
      current->creation_directory_sync = true;
      if (!synchronize(current->parent->fd, "Cannot synchronize the new directory's parent", &error)) goto failed;
      current->creation_parent_sync = true;
      if (!validate(current, false, &error)) goto failed;
    }
    if (final) break;
    component = slash + 1;
  }
  if (private && current->parent == NULL) {
    current->policy = PRIVATE_POLICY;
    if (!admit(current, &current->admitted, &error)) goto failed;
  }
  free(path);
  return wrap_resource(env, state, current);
failed:
  free(path);
  if (current->created && error.creation != NULL) {
    failure binding_error = {0};
    creation.binding_verified = check_binding(current, &binding_error);
    creation.directory_synced = current->creation_directory_sync;
    creation.parent_synced = current->creation_parent_sync;
  }
  observe_release(&error, release_resource(current));
  return throw_failure(env, &error, NULL, 0);
}

static DIR *directory_stream(resource *item, failure *error) {
  int copied = fcntl(item->fd, F_DUPFD_CLOEXEC, 0);
  if (copied < 0) { fail(error, errno, "fcntl(F_DUPFD_CLOEXEC)", "Cannot retain a directory enumeration descriptor"); return NULL; }
  DIR *stream = fdopendir(copied);
  if (stream == NULL) {
    int number = errno;
    observe_release(error, close(copied) == 0 ? 0 : errno);
    fail(error, number, "fdopendir", "Cannot enumerate the retained directory");
    return NULL;
  }
  rewinddir(stream);
  return stream;
}

static bool close_directory_stream(DIR *stream, failure *error) {
  int number = closedir(stream) == 0 ? 0 : errno;
  if (number == 0) return true;
  observe_release(error, number);
  if (error->number == 0) fail(error, number, "closedir", "Directory enumeration descriptor release is uncertain");
  return false;
}

static bool empty_directory(resource *item, failure *error) {
  DIR *stream = directory_stream(item, error);
  if (stream == NULL) return false;
  struct dirent *entry;
  bool empty = true;
  errno = 0;
  while ((entry = readdir(stream)) != NULL) {
    if (strcmp(entry->d_name, ".") != 0 && strcmp(entry->d_name, "..") != 0) { empty = false; break; }
    errno = 0;
  }
  int number = errno;
  if (empty && number != 0) fail(error, number, "readdir", "Cannot complete empty-directory inspection");
  if (!empty) fail(error, ENOTEMPTY, "readdir", "New private child is not empty");
  bool closed = close_directory_stream(stream, error);
  return empty && number == 0 && closed;
}

static napi_value open_child(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *parent = cap->resource;
  resource *item = NULL;
  failure error = {0};
  if (!ready(parent, DIRECTORY, &error)) goto failed;
  if (parent->policy != SOURCE_POLICY && parent->policy != PRIVATE_POLICY) {
    fail(&error, EACCES, "capability", "Child traversal requires a source or private root");
    goto failed;
  }
  int fd = openat(parent->fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { fail(&error, errno, "openat", "Cannot retain the literal child directory"); goto failed; }
  item = new_resource(state, fd, DIRECTORY, parent->policy, parent, name, &error);
  if (item == NULL || !validate(item, false, &error)) goto failed;
  free(name);
  return wrap_resource(env, state, item);
failed:
  free(name);
  if (item != NULL) (void)release_resource(item);
  return throw_failure(env, &error, NULL, 0);
}

static napi_value create_private_child(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *parent = cap->resource;
  resource *item = NULL;
  creation_observations creation = {.kind = "directory"};
  failure error = {.creation = &creation};
  struct stat parent_before;
  struct stat parent_after;
  if (!ready(parent, DIRECTORY, &error)) goto failed;
  if (parent->policy != PRIVATE_POLICY) {
    fail(&error, EACCES, "capability", "Private child creation requires an admitted private parent");
    goto failed;
  }
  if (fstat(parent->fd, &parent_before) != 0) { fail(&error, errno, "fstat", "Cannot observe the private parent before creation"); goto failed; }
  creation.creation_uncertain = true;
  if (mkdirat(parent->fd, name, 0700) != 0) {
    if (errno == EEXIST) creation.creation_uncertain = false;
    fail(&error, errno, "mkdirat", "Cannot exclusively create the private child");
    goto failed;
  }
  creation.entry_created = true;
  int fd = openat(parent->fd, name, O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  if (fd < 0) { fail(&error, errno, "openat", "Cannot retain the newly created private child"); goto failed; }
  item = new_resource(state, fd, DIRECTORY, PRIVATE_POLICY, parent, name, &error);
  if (item == NULL) goto failed;
  item->created = true;
  item->publication = PUBLISHED;
  if (!validate(item, true, &error) || !empty_directory(item, &error)) goto failed;
  if (!synchronize(item->fd, "Cannot synchronize the new private child", &error)) goto failed;
  item->creation_directory_sync = true;
  if (!synchronize(parent->fd, "Cannot synchronize the retained parent after child creation", &error)) goto failed;
  item->creation_parent_sync = true;
  if (!validate(item, true, &error) || !empty_directory(item, &error) || !validate(item, true, &error)) goto failed;
  if (fstat(parent->fd, &parent_after) != 0) { fail(&error, errno, "fstat", "Cannot observe the private parent after creation"); goto failed; }
  napi_value facts = facts_value(env, item, &error);
  if (facts == NULL) goto failed;
  napi_value wrapped = wrap_resource(env, state, item);
  if (wrapped == NULL) { free(name); return NULL; }
  free(name);
  napi_value result = object(env);
  property(env, result, "capability", wrapped);
  property(env, result, "facts", facts);
  property(env, result, "parentBeforeFacts", stat_value(env, &parent_before));
  property(env, result, "parentAfterFacts", stat_value(env, &parent_after));
  boolean_property(env, result, "published", true);
  text_property(env, result, "mechanism", "mkdirat");
  napi_value sync = object(env);
  boolean_property(env, sync, "directory", true);
  boolean_property(env, sync, "parent", true);
  property(env, result, "creationSync", sync);
  return result;
failed:
  free(name);
  if (item != NULL) {
    resource observations = *item;
    failure binding_error = {0};
    creation.binding_verified = check_binding(item, &binding_error);
    creation.directory_synced = item->creation_directory_sync;
    creation.parent_synced = item->creation_parent_sync;
    observe_release(&error, release_resource(item));
    return throw_failure(env, &error, &observations, 0);
  }
  return throw_failure(env, &error, NULL, 0);
}

static bool representable_entry(const char *name, failure *error) {
  size_t length = strnlen(name, NAME_MAX + 1);
  if (length == 0 || length > NAME_MAX || strchr(name, '/') != NULL) return fail(error, EILSEQ, "readdir", "Directory entry is not a representable literal component");
  const unsigned char *bytes = (const unsigned char *)name;
  for (size_t offset = 0; offset < length;) {
    unsigned char first = bytes[offset++];
    if (first < 0x80) continue;
    size_t continuation;
    uint32_t value;
    uint32_t minimum;
    if (first >= 0xc2 && first <= 0xdf) { continuation = 1; value = first & 0x1f; minimum = 0x80; }
    else if (first >= 0xe0 && first <= 0xef) { continuation = 2; value = first & 0x0f; minimum = 0x800; }
    else if (first >= 0xf0 && first <= 0xf4) { continuation = 3; value = first & 0x07; minimum = 0x10000; }
    else return fail(error, EILSEQ, "readdir", "Directory entry is not valid UTF-8");
    if (length - offset < continuation) return fail(error, EILSEQ, "readdir", "Directory entry contains truncated UTF-8");
    for (size_t part = 0; part < continuation; ++part) {
      unsigned char byte = bytes[offset++];
      if ((byte & 0xc0) != 0x80) return fail(error, EILSEQ, "readdir", "Directory entry is not valid UTF-8");
      value = (value << 6) | (byte & 0x3f);
    }
    if (value < minimum || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return fail(error, EILSEQ, "readdir", "Directory entry cannot round-trip through a JavaScript string");
  }
  return true;
}

static bool private_directory(resource *item, failure *error) {
  if (!ready(item, DIRECTORY, error)) return false;
  if (item->policy != PRIVATE_POLICY) return fail(error, EACCES, "capability", "This observation requires an admitted private directory");
  return true;
}

static napi_value list_directory_policy(napi_env env, napi_callback_info info, admission_policy policy) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  double maximum;
  if (napi_get_value_double(env, values[1], &maximum) != napi_ok || !(maximum >= 0 && maximum <= DIRECTORY_ENTRY_LIMIT) || maximum != (double)(uint32_t)maximum) return invalid(env, "Directory entry limit must be an integer from 0 through 100000");
  resource *item = cap->resource;
  failure error = {0};
  if (!ready(item, DIRECTORY, &error)) return throw_failure(env, &error, item, 0);
  if (item->policy != policy) {
    fail(&error, EACCES, "capability", "Directory listing requires its exact admitted source/private policy");
    return throw_failure(env, &error, item, 0);
  }
  struct stat before;
  struct stat after;
  if (fstat(item->fd, &before) != 0) { fail(&error, errno, "fstat", "Cannot observe the directory before listing"); return throw_failure(env, &error, item, 0); }
  DIR *stream = directory_stream(item, &error);
  if (stream == NULL) return throw_failure(env, &error, item, 0);
  napi_value entries;
  check(napi_create_array(env, &entries));
  uint32_t count = 0;
  while (true) {
    errno = 0;
    struct dirent *entry = readdir(stream);
    if (entry == NULL) {
      if (errno != 0) fail(&error, errno, "readdir", "Directory listing did not reach a confirmed end");
      break;
    }
    if (strcmp(entry->d_name, ".") == 0 || strcmp(entry->d_name, "..") == 0) continue;
    if (count >= (uint32_t)maximum) { fail(&error, EOVERFLOW, "readdir", "Directory entry limit exceeded; no partial listing is returned"); break; }
    if (!representable_entry(entry->d_name, &error)) break;
    struct stat entry_stat;
    if (fstatat(item->fd, entry->d_name, &entry_stat, AT_SYMLINK_NOFOLLOW) != 0) { fail(&error, errno, "fstatat", "Cannot observe an enumerated literal entry"); break; }
    napi_handle_scope scope;
    check(napi_open_handle_scope(env, &scope));
    napi_value observed = object(env);
    text_property(env, observed, "name", entry->d_name);
    property(env, observed, "facts", stat_value(env, &entry_stat));
    check(napi_set_element(env, entries, count++, observed));
    check(napi_close_handle_scope(env, scope));
  }
  bool closed = close_directory_stream(stream, &error);
  if (error.number != 0 || !closed) return throw_failure(env, &error, item, 0);
  if (fstat(item->fd, &after) != 0) { fail(&error, errno, "fstat", "Cannot observe the directory after listing"); return throw_failure(env, &error, item, 0); }
  if (!same_file(&before, &after)) { fail(&error, ESTALE, "fstat", "Directory observations changed during listing"); return throw_failure(env, &error, item, 0); }
  if (!validate(item, false, &error)) return throw_failure(env, &error, item, 0);
  napi_value result = object(env);
  property(env, result, "entries", entries);
  property(env, result, "parentBeforeFacts", stat_value(env, &before));
  property(env, result, "parentAfterFacts", stat_value(env, &after));
  boolean_property(env, result, "complete", true);
  return result;
}

static napi_value list_directory(napi_env env, napi_callback_info info) {
  return list_directory_policy(env, info, PRIVATE_POLICY);
}
static napi_value list_source_directory(napi_env env, napi_callback_info info) {
  return list_directory_policy(env, info, SOURCE_POLICY);
}

static napi_value observe_capacity(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (!private_directory(item, &error)) return throw_failure(env, &error, item, 0);
  struct stat before;
  struct stat after;
  filesystem_facts fs_before;
  filesystem_facts fs_after;
  struct statvfs capacity;
  if (fstat(item->fd, &before) != 0) { fail(&error, errno, "fstat", "Cannot observe the capacity parent"); goto failed; }
  if (!filesystem(item->fd, &fs_before, &error)) goto failed;
  if (fstatvfs(item->fd, &capacity) != 0) { fail(&error, errno, "fstatvfs", "Cannot observe retained filesystem capacity"); goto failed; }
  uintmax_t unit = (uintmax_t)capacity.f_frsize;
  uintmax_t available = (uintmax_t)capacity.f_bavail;
  if (unit == 0 || capacity.f_bavail == (fsblkcnt_t)-1) { fail(&error, ENOTSUP, "fstatvfs", "Caller-available allocation units are not reported"); goto failed; }
  if (available > UINTMAX_MAX / unit) { fail(&error, EOVERFLOW, "fstatvfs", "Reported capacity cannot be represented without overflow"); goto failed; }
  if (!filesystem(item->fd, &fs_after, &error)) goto failed;
  if (fstat(item->fd, &after) != 0) { fail(&error, errno, "fstat", "Cannot observe the capacity parent afterward"); goto failed; }
  if (!same_file(&before, &after) || fs_before.type != fs_after.type || strcmp(fs_before.fsid, fs_after.fsid) != 0 || fs_before.read_only != fs_after.read_only) {
    fail(&error, ESTALE, "fstatvfs", "Retained directory or filesystem observations changed during capacity inspection");
    goto failed;
  }
  if (!validate(item, false, &error)) goto failed;
  napi_value result = object(env);
  property(env, result, "filesystem", filesystem_value(env, &fs_after));
  unsigned_property(env, result, "allocationUnitBytes", unit);
  unsigned_property(env, result, "availableBytes", available * unit);
  napi_value null_value;
  check(napi_get_null(env, &null_value));
  if (capacity.f_ffree == (fsfilcnt_t)-1) property(env, result, "freeEntries", null_value);
  else unsigned_property(env, result, "freeEntries", (uintmax_t)capacity.f_ffree);
  if (capacity.f_favail == (fsfilcnt_t)-1) property(env, result, "availableEntries", null_value);
  else unsigned_property(env, result, "availableEntries", (uintmax_t)capacity.f_favail);
  property(env, result, "parentBeforeFacts", stat_value(env, &before));
  property(env, result, "parentAfterFacts", stat_value(env, &after));
  boolean_property(env, result, "reservation", false);
  return result;
failed:
  return throw_failure(env, &error, item, 0);
}

static napi_value open_leaf(napi_env env, napi_callback_info info, bool output,
                            bool private_record, bool output_audit) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *parent = cap->resource;
  creation_observations creation = {.kind = "staging"};
  failure error = {.creation = output ? &creation : NULL};
  resource *item = NULL;
  if (!ready(parent, DIRECTORY, &error)) goto failed;
  if (output || private_record || output_audit ? parent->policy != PRIVATE_POLICY : parent->policy != SOURCE_POLICY) {
    fail(&error, EACCES, "capability", "Source and private destination policies are distinct");
    goto failed;
  }
  int flags = O_NOFOLLOW | O_CLOEXEC | (output ? O_WRONLY | O_CREAT | O_EXCL : O_RDONLY | O_NONBLOCK);
  creation.creation_uncertain = output;
  int fd = openat(parent->fd, name, flags, 0600);
  if (fd < 0) {
    if (errno == EEXIST) creation.creation_uncertain = false;
    fail(&error, errno, "openat", "Cannot open the literal file component");
    goto failed;
  }
  creation.entry_created = output;
  item = new_resource(state, fd, output ? OUTPUT : output_audit ? OUTPUT_AUDIT : SOURCE,
                      output || private_record || output_audit ? PRIVATE_POLICY : SOURCE_POLICY, parent, name, &error);
  if (item == NULL) goto failed;
  item->created = output;
  if (private_record && (uintmax_t)item->admitted.st_size > RECORD_LIMIT) {
    fail(&error, EFBIG, "fstat", "Private control records cannot exceed 64 MiB");
    goto failed;
  }
  if (private_record && (item->admitted.st_mode & 07777) != 0600) {
    fail(&error, EACCES, "fstat", "Private control records require mode 0600");
    goto failed;
  }
  if (output_audit && (uintmax_t)item->admitted.st_size > OUTPUT_LIMIT) {
    fail(&error, EFBIG, "fstat", "Private output audit readers cannot exceed 1 GiB");
    goto failed;
  }
  if (output) {
    item->staging_name = strdup(name);
    if (item->staging_name == NULL) { fail(&error, ENOMEM, "strdup", "Cannot retain staging component"); goto failed; }
    if (item->admitted.st_size != 0 || (item->admitted.st_mode & 07777) != 0600) {
      fail(&error, EACCES, "fstat", "New staging file does not have zero size and mode 0600");
      goto failed;
    }
  }
  if (!validate(item, true, &error)) goto failed;
  free(name);
  return wrap_resource(env, state, item);
failed:
  free(name);
  if (item != NULL) {
    resource observations = *item;
    failure binding_error = {0};
    creation.binding_verified = check_binding(item, &binding_error);
    observe_release(&error, release_resource(item));
    return throw_failure(env, &error, &observations, 0);
  }
  return throw_failure(env, &error, NULL, 0);
}

static napi_value open_source(napi_env env, napi_callback_info info) { return open_leaf(env, info, false, false, false); }

static napi_value inspect_source_link(napi_env env, napi_callback_info info) {
  napi_value values[3], target = NULL;
  owner *state = arguments(env, info, 3, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  double maximum;
  if (napi_get_value_double(env, values[2], &maximum) != napi_ok || !(maximum >= 1 && maximum <= 32768)
      || maximum != (double)(uint32_t)maximum) return invalid(env, "Link target bound must be 1 through 32768");
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *parent = cap->resource, *link = NULL;
  failure error = {0};
  struct stat parent_before, parent_after, before, after, binding;
  char buffer[32769];
  ssize_t count;
  int fd;
  if (parent->policy != SOURCE_POLICY || !ready(parent, DIRECTORY, &error)) {
    if (error.number == 0) fail(&error, EACCES, "capability", "Link observation requires a read-only source parent");
    goto failed;
  }
  if (fstat(parent->fd, &parent_before) != 0) { fail(&error, errno, "fstat", "Cannot observe source parent"); goto failed; }
#ifdef __APPLE__
  ssize_t (*read_retained_link)(int, char *, size_t) = (ssize_t (*)(int, char *, size_t))dlsym(RTLD_DEFAULT, "freadlink");
  if (read_retained_link == NULL) { fail(&error, ENOTSUP, "freadlink", "Retained symbolic-link reads require macOS 13 or later"); goto failed; }
  fd = openat(parent->fd, name, O_RDONLY | O_SYMLINK | O_NOFOLLOW | O_CLOEXEC);
#else
  fd = openat(parent->fd, name, O_PATH | O_NOFOLLOW | O_CLOEXEC);
#endif
  if (fd < 0) { fail(&error, errno, "openat", "Cannot retain the literal link leaf"); goto failed; }
  link = new_resource(state, fd, SOURCE, SOURCE_POLICY, parent, name, &error);
  if (link == NULL) goto failed;
  before = link->admitted;
  if (!S_ISLNK(before.st_mode) || before.st_nlink < 1 || before.st_size < 0) {
    fail(&error, EINVAL, "fstat", "A live symbolic link is required"); goto failed;
  }
#ifdef __APPLE__
  count = read_retained_link(link->fd, buffer, (size_t)maximum + 1);
#else
  count = readlinkat(link->fd, "", buffer, (size_t)maximum + 1);
#endif
  if (count < 0) { fail(&error, errno, "readlink", "Cannot read the retained symbolic link"); goto failed; }
  if (count == 0 || count > (ssize_t)maximum || memchr(buffer, '\0', (size_t)count) != NULL) {
    fail(&error, EOVERFLOW, "readlink", "Symbolic-link target exceeds its exact byte bound"); goto failed;
  }
  if (fstat(link->fd, &after) != 0 || fstatat(parent->fd, name, &binding, AT_SYMLINK_NOFOLLOW) != 0
      || fstat(parent->fd, &parent_after) != 0) { fail(&error, errno, "fstat", "Cannot reobserve the retained link and parent"); goto failed; }
  if (!same_file(&before, &after) || !same_file(&after, &binding) || !same_file(&parent_before, &parent_after)) {
    fail(&error, ESTALE, "readlink", "Symbolic-link or parent observations changed"); goto failed;
  }
  if (!ready(parent, DIRECTORY, &error)) goto failed;
  if (napi_create_buffer_copy(env, (size_t)count, buffer, NULL, &target) != napi_ok) {
    fail(&error, ENOMEM, "napi_create_buffer_copy", "Cannot expose copied link bytes"); goto failed;
  }
  observe_release(&error, release_resource(link)); link = NULL;
  if (error.cleanup_error != 0) { fail(&error, error.cleanup_error, "close", "Link release could not be confirmed"); goto failed; }
  free(name);
  napi_value result = object(env);
  property(env, result, "targetBytes", target);
  property(env, result, "before", stat_value(env, &before));
  property(env, result, "after", stat_value(env, &after));
  boolean_property(env, result, "bindingVerified", true);
  boolean_property(env, result, "released", true);
  return result;
failed:
  if (link != NULL) observe_release(&error, release_resource(link));
  free(name);
  return throw_failure(env, &error, NULL, 0);
}
static napi_value open_private_record(napi_env env, napi_callback_info info) { return open_leaf(env, info, false, true, false); }
static napi_value open_private_output(napi_env env, napi_callback_info info) { return open_leaf(env, info, false, false, true); }
static napi_value create_file(napi_env env, napi_callback_info info) { return open_leaf(env, info, true, false, false); }

static bool validate_lease(resource *item, failure *error) {
  if (item->kind != LEASE || !item->lease_held || item->failed || item->removed) {
    return fail(error, EACCES, "flock", "A live native-owned management lease is required");
  }
  if (!validate(item, true, error)) { item->failed = true; return false; }
  if ((item->admitted.st_mode & 07777) != 0600 || item->admitted.st_size != 0) {
    item->failed = true;
    return fail(error, EACCES, "fstat", "Management lease files require mode 0600 and zero length");
  }
  return true;
}

static napi_value acquire_lease(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *parent = cap->resource;
  creation_observations creation = {.kind = "lease"};
  failure error = {.creation = &creation};
  resource *item = NULL;
  if (!ready(parent, DIRECTORY, &error)) goto failed;
  if (parent->policy != PRIVATE_POLICY) {
    fail(&error, EACCES, "capability", "Management leases require an admitted private parent");
    goto failed;
  }
  const int flags = O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK;
  creation.creation_uncertain = true;
  int fd = openat(parent->fd, name, flags | O_CREAT | O_EXCL, 0600);
  bool created = fd >= 0;
  creation.entry_created = created;
  if (fd < 0 && errno == EEXIST) {
    creation.creation_uncertain = false;
    fd = openat(parent->fd, name, flags);
  }
  if (fd < 0) { fail(&error, errno, "openat", "Cannot retain the management lease file"); goto failed; }
  item = new_resource(state, fd, LEASE, PRIVATE_POLICY, parent, name, &error);
  if (item == NULL) goto failed;
  item->created = created;
  if (!validate(item, true, &error)) goto failed;
  if ((item->admitted.st_mode & 07777) != 0600 || item->admitted.st_size != 0) {
    fail(&error, EACCES, "fstat", "Management lease files require mode 0600 and zero length");
    goto failed;
  }
  if (flock(item->fd, LOCK_EX | LOCK_NB) != 0) {
    fail(&error, errno, "flock", "Management lease is unavailable");
    goto failed;
  }
  item->lease_held = true;
  if (!validate_lease(item, &error)) goto failed;
  free(name);
  return wrap_resource(env, state, item);
failed:
  free(name);
  if (item != NULL) {
    resource observations = *item;
    creation.facts = item->admitted;
    creation.facts_known = true;
    failure binding_error = {0};
    creation.binding_verified = check_binding(item, &binding_error);
    observe_release(&error, release_resource(item));
    if (creation.release_error == 0) observations.lease_held = false;
    return throw_failure(env, &error, &observations, 0);
  }
  return throw_failure(env, &error, NULL, 0);
}

static napi_value inspect(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (!(item->kind == LEASE ? validate_lease(item, &error) : validate(item, item->kind == SOURCE || item->kind == OUTPUT_AUDIT || (item->kind == OUTPUT && !item->failed), &error))) {
    if (item->kind == SOURCE || item->kind == OUTPUT_AUDIT) item->failed = true;
    return throw_failure(env, &error, item, 0);
  }
  napi_value result = facts_value(env, item, &error);
  return result == NULL ? throw_failure(env, &error, item, 0) : result;
}

static napi_value inspect_binding(napi_env env, napi_callback_info info, bool file_parent) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  resource *parent = file_parent ? cap->resource->parent : cap->resource;
  if (parent == NULL || parent->kind != DIRECTORY || (file_parent && cap->resource->kind == DIRECTORY)) return invalid(env, "Expected a retained parent capability");
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  failure error = {0};
  if (!validate(parent, false, &error)) { free(name); return throw_failure(env, &error, cap->resource, 0); }
  struct stat stat;
  int status = fstatat(parent->fd, name, &stat, AT_SYMLINK_NOFOLLOW);
  int number = errno;
  if (status == 0 && !literal_spelling(parent, name, &error)) { free(name); return throw_failure(env, &error, cap->resource, 0); }
  free(name);
  if (status == 0) return stat_value(env, &stat);
  if (number != ENOENT) { fail(&error, number, "fstatat", "Cannot inspect the literal entry binding"); return throw_failure(env, &error, cap->resource, 0); }
  napi_value result;
  check(napi_get_null(env, &result));
  return result;
}

static napi_value inspect_directory_binding(napi_env env, napi_callback_info info) { return inspect_binding(env, info, false); }
static napi_value inspect_file_binding(napi_env env, napi_callback_info info) { return inspect_binding(env, info, true); }

static napi_value read_chunk(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  double requested;
  if (napi_get_value_double(env, values[1], &requested) != napi_ok || !(requested >= 1 && requested <= CHUNK_LIMIT) || requested != (double)(size_t)requested) return invalid(env, "Read size must be an integer from 1 through 1048576");
  resource *item = cap->resource;
  failure error = {0};
  if (!ready(item, item->kind == OUTPUT_AUDIT ? OUTPUT_AUDIT : SOURCE, &error)) return throw_failure(env, &error, item, 0);
  size_t length = (size_t)requested;
  void *buffer = malloc(length);
  if (buffer == NULL) { fail(&error, ENOMEM, "malloc", "Cannot allocate a bounded source chunk"); return throw_failure(env, &error, item, 0); }
  size_t completed = 0;
  bool observed_eof = false;
  while (completed < length) {
    ssize_t count = read(item->fd, (char *)buffer + completed, length - completed);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) { fail(&error, errno, "read", "Source read failed after confirmed progress"); goto failed; }
    if (count == 0) {
      if (item->bytes_read != (uintmax_t)item->admitted.st_size) {
        fail(&error, EIO, "read", "Source returned EOF before its admitted size");
        goto failed;
      }
      observed_eof = true;
      break;
    }
    completed += (size_t)count;
    item->bytes_read += (uint64_t)count;
  }
  if (!validate(item, true, &error)) goto failed;
  if (observed_eof) item->eof_observed = true;
  napi_value result;
  check(napi_create_buffer_copy(env, completed, buffer, NULL, &result));
  free(buffer);
  return result;
failed:
  item->failed = true;
  free(buffer);
  return throw_failure(env, &error, item, completed);
}

static napi_value write_chunk(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  bool is_buffer;
  check(napi_is_buffer(env, values[1], &is_buffer));
  if (!is_buffer) return invalid(env, "Expected a Buffer");
  void *input;
  size_t length;
  check(napi_get_buffer_info(env, values[1], &input, &length));
  if (length > CHUNK_LIMIT) return invalid(env, "Write chunks cannot exceed 1048576 bytes");
  resource *item = cap->resource;
  failure error = {0};
  if (!ready(item, OUTPUT, &error)) return throw_failure(env, &error, item, 0);
  if ((uintmax_t)item->admitted.st_size != item->bytes_written || item->bytes_written > INT64_MAX - length) {
    item->failed = true;
    fail(&error, EFBIG, "write", "Output position or size exceeds the sequential stream bounds");
    return throw_failure(env, &error, item, 0);
  }
  void *buffer = length == 0 ? NULL : malloc(length);
  if (length != 0 && buffer == NULL) { fail(&error, ENOMEM, "malloc", "Cannot copy a bounded output chunk"); return throw_failure(env, &error, item, 0); }
  if (length != 0) memcpy(buffer, input, length);
  if (length != 0) {
    item->file_synced = false;
    item->file_full_synced = false;
  }
  size_t completed = 0;
  while (completed < length) {
    ssize_t count = write(item->fd, (char *)buffer + completed, length - completed);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) { fail(&error, count == 0 ? EIO : errno, "write", "Output write failed after confirmed progress"); goto failed; }
    completed += (size_t)count;
    item->bytes_written += (uint64_t)count;
  }
  struct stat current;
  if (fstat(item->fd, &current) != 0) { fail(&error, errno, "fstat", "Cannot inspect output after writing"); goto failed; }
  if (!same_identity(&item->admitted, &current) || !same_security(&item->admitted, &current) || current.st_nlink != 1 || (uintmax_t)current.st_size != item->bytes_written) {
    fail(&error, ESTALE, "fstat", "Output changed during writing");
    goto failed;
  }
  item->admitted = current;
  if (!validate(item, true, &error)) goto failed;
  free(buffer);
  napi_value result = object(env);
  number_property(env, result, "bytesWritten", (double)completed);
  unsigned_property(env, result, "totalBytesWritten", item->bytes_written);
  return result;
failed:
  item->failed = true;
  free(buffer);
  return throw_failure(env, &error, item, completed);
}

static napi_value set_executable(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  bool executable;
  if (!get_boolean(env, values[1], &executable)) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (!ready(item, OUTPUT, &error)) return throw_failure(env, &error, item, 0);
  mode_t desired = executable ? 0700 : 0600;
  item->file_synced = false;
  item->file_full_synced = false;
  if (fchmod(item->fd, desired) != 0) { fail(&error, errno, "fchmod", "Cannot set metadata on the newly created output"); goto failed; }
  struct stat current;
  if (fstat(item->fd, &current) != 0) { fail(&error, errno, "fstat", "Cannot inspect output metadata"); goto failed; }
  if (!same_identity(&item->admitted, &current) || current.st_uid != item->admitted.st_uid || current.st_gid != item->admitted.st_gid || current.st_size != item->admitted.st_size || current.st_nlink != 1 || (current.st_mode & 07777) != desired) {
    fail(&error, ESTALE, "fstat", "Output metadata changed unexpectedly");
    goto failed;
  }
  item->admitted = current;
  if (!validate(item, true, &error)) goto failed;
  napi_value result = object(env);
  boolean_property(env, result, "executable", executable);
  number_property(env, result, "mode", (double)current.st_mode);
  return result;
failed:
  item->failed = true;
  return throw_failure(env, &error, item, 0);
}

static napi_value sync_file(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  bool full;
  if (!get_boolean(env, values[1], &full)) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (item->kind != OUTPUT || item->failed || item->removed || item->publication == INDETERMINATE) {
    fail(&error, EINVAL, "capability", "File synchronization requires a live owned output");
    return throw_failure(env, &error, item, 0);
  }
  if (!validate(item, true, &error)) goto failed;
  if (full) {
#ifdef __APPLE__
    int status;
    do { status = fcntl(item->fd, F_FULLFSYNC); } while (status < 0 && errno == EINTR);
    if (status != 0) { fail(&error, errno, "fcntl(F_FULLFSYNC)", "Cannot fully synchronize the retained output"); goto failed; }
    item->file_full_synced = true;
#else
    fail(&error, ENOTSUP, "fcntl(F_FULLFSYNC)", "Full synchronization is a Darwin operation");
    goto failed;
#endif
  } else {
    if (!synchronize(item->fd, "Cannot synchronize the retained output", &error)) goto failed;
    item->file_synced = true;
  }
  if (!validate(item, true, &error)) goto failed;
  napi_value result = object(env);
  boolean_property(env, result, "synced", true);
  boolean_property(env, result, "full", full);
  return result;
failed:
  item->failed = true;
  return throw_failure(env, &error, item, 0);
}

static napi_value sync_directory(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  resource *item = cap->resource;
  resource *directory = item->kind == OUTPUT ? item->parent : item;
  failure error = {0};
  if (directory->kind != DIRECTORY || directory->policy != PRIVATE_POLICY || !validate(directory, false, &error)) {
    if (error.number == 0) fail(&error, EACCES, "capability", "Directory synchronization requires a private destination");
    return throw_failure(env, &error, item, 0);
  }
  if (!synchronize(directory->fd, "Cannot synchronize the retained parent directory", &error)) return throw_failure(env, &error, item, 0);
  item->directory_synced = true;
  if (!validate(directory, false, &error)) return throw_failure(env, &error, item, 0);
  napi_value result = object(env);
  boolean_property(env, result, "synced", true);
  return result;
}

static void reconcile_publication(resource *item, const char *final_name) {
  struct stat staging;
  struct stat final;
  int staging_status = fstatat(item->parent->fd, item->staging_name, &staging, AT_SYMLINK_NOFOLLOW);
  int staging_error = errno;
  int final_status = fstatat(item->parent->fd, final_name, &final, AT_SYMLINK_NOFOLLOW);
  int final_error = errno;
  bool own_staging = staging_status == 0 && same_identity(&item->admitted, &staging);
  bool own_final = final_status == 0 && same_identity(&item->admitted, &final);
  if (own_final && staging_status < 0 && staging_error == ENOENT) item->publication = PUBLISHED;
  else if (own_staging && ((final_status < 0 && final_error == ENOENT) || (final_status == 0 && !own_final))) item->publication = UNPUBLISHED;
  else item->publication = INDETERMINATE;
}

static napi_value publish(napi_env env, napi_callback_info info) {
  napi_value values[2];
  owner *state = arguments(env, info, 2, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  char *name = get_string(env, values[1], false);
  if (name == NULL) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (!ready(item, OUTPUT, &error)) goto failed;
  if (strcmp(name, item->staging_name) == 0) { fail(&error, EINVAL, "rename", "Final name must differ from the staging name"); goto failed; }
  item->publication = INDETERMINATE;
  item->rename_attempted = true;
  item->directory_synced = false;
  int status;
#ifdef __APPLE__
  const char *mechanism = "renameatx_np(RENAME_EXCL)";
  status = renameatx_np(item->parent->fd, item->staging_name, item->parent->fd, name, RENAME_EXCL);
#else
  const char *mechanism = "renameat2(RENAME_NOREPLACE)";
#ifdef SYS_renameat2
  status = (int)syscall(SYS_renameat2, item->parent->fd, item->staging_name, item->parent->fd, name, RENAME_NOREPLACE);
#else
  errno = ENOSYS;
  status = -1;
#endif
#endif
  int rename_error = errno;
  if (status != 0) {
    reconcile_publication(item, name);
    fail(&error, rename_error, mechanism, "Exclusive publication failed; retained bindings were inspected");
    if (item->publication == PUBLISHED) { free(item->name); item->name = name; name = NULL; }
    goto failed;
  }
  item->publication = PUBLISHED;
  free(item->name);
  item->name = name;
  name = NULL;
  struct stat current;
  if (fstat(item->fd, &current) != 0) { fail(&error, errno, "fstat", "Cannot inspect output after publication"); goto failed; }
  /* Rename may update ctime; all content, type, ownership and link facts remain bound. */
  if (!same_identity(&item->admitted, &current) || !same_security(&item->admitted, &current) || current.st_size != item->admitted.st_size || current.st_nlink != 1 || MTIME(current).tv_sec != MTIME(item->admitted).tv_sec || MTIME(current).tv_nsec != MTIME(item->admitted).tv_nsec) {
    fail(&error, ESTALE, "fstat", "Published output observations changed");
    goto failed;
  }
  item->admitted = current;
  if (!validate(item, true, &error)) goto failed;
  napi_value facts = facts_value(env, item, &error);
  if (facts == NULL) goto failed;
  napi_value result = object(env);
  boolean_property(env, result, "published", true);
  text_property(env, result, "mechanism", mechanism);
  property(env, result, "facts", facts);
  return result;
failed:
  item->failed = true;
  free(name);
  return throw_failure(env, &error, item, 0);
}

static void reconcile_record_replacement(resource *item, resource *target) {
  struct stat staging;
  struct stat final;
  int staging_status = fstatat(item->parent->fd, item->staging_name, &staging, AT_SYMLINK_NOFOLLOW);
  int staging_error = errno;
  int final_status = fstatat(item->parent->fd, target->name, &final, AT_SYMLINK_NOFOLLOW);
  if (final_status == 0 && same_identity(&item->admitted, &final) &&
      staging_status < 0 && staging_error == ENOENT) {
    item->publication = PUBLISHED;
  } else if (staging_status == 0 && same_file(&item->admitted, &staging) &&
             final_status == 0 && same_file(&target->admitted, &final)) {
    item->publication = UNPUBLISHED;
  } else {
    item->publication = INDETERMINATE;
  }
}

static napi_value replace_private_record(napi_env env, napi_callback_info info) {
  napi_value values[3];
  owner *state = arguments(env, info, 3, values);
  if (state == NULL) return NULL;
  capability *new_cap = get_capability(env, state, values[0], false);
  if (new_cap == NULL) return NULL;
  capability *old_cap = get_capability(env, state, values[1], false);
  if (old_cap == NULL) return NULL;
  capability *lease_cap = get_capability(env, state, values[2], false);
  if (lease_cap == NULL) return NULL;
  resource *item = new_cap->resource;
  resource *target = old_cap->resource;
  resource *lease = lease_cap->resource;
  failure error = {0};
  char *name = NULL;
  if (!ready(item, OUTPUT, &error)) goto failed;
  if (target->kind != SOURCE || target->policy != PRIVATE_POLICY) {
    fail(&error, EACCES, "capability", "Replacement requires a retained private control-record reader");
    goto failed;
  }
  item->replacement_target = target->admitted;
  item->replacement_target_known = true;
  if (!ready(target, SOURCE, &error) || !validate_lease(lease, &error)) goto failed;
  if (!same_identity(&item->parent->admitted, &target->parent->admitted) ||
      !same_identity(&item->parent->admitted, &lease->parent->admitted)) {
    fail(&error, EXDEV, "capability", "Staging, target and lease must share the same retained private parent");
    goto failed;
  }
  if (same_identity(&item->admitted, &target->admitted) ||
      same_identity(&item->admitted, &lease->admitted) ||
      same_identity(&target->admitted, &lease->admitted) ||
      strcmp(item->name, target->name) == 0 || strcmp(item->name, lease->name) == 0 ||
      strcmp(target->name, lease->name) == 0) {
    fail(&error, EINVAL, "capability", "Staging, target and lease must be distinct private objects and names");
    goto failed;
  }
  if (!target->eof_observed || target->bytes_read != (uintmax_t)target->admitted.st_size) {
    fail(&error, EINVAL, "read", "Current control record must be consumed through actual EOF before replacement");
    goto failed;
  }
  if ((uintmax_t)target->admitted.st_size > RECORD_LIMIT || (uintmax_t)item->admitted.st_size > RECORD_LIMIT) {
    fail(&error, EFBIG, "fstat", "Private control records cannot exceed 64 MiB");
    goto failed;
  }
  if ((target->admitted.st_mode & 07777) != 0600 || (item->admitted.st_mode & 07777) != 0600 ||
      (uintmax_t)item->admitted.st_size != item->bytes_written) {
    fail(&error, EACCES, "fstat", "Control record replacement requires verified sequential mode-0600 output");
    goto failed;
  }
#ifdef __APPLE__
  bool synchronized = item->file_full_synced;
#else
  bool synchronized = item->file_synced;
#endif
  if (!synchronized) {
    fail(&error, EINVAL, "fsync", "The new private control record must be synchronized before replacement");
    goto failed;
  }
  struct stat staging_parent;
  struct stat target_parent;
  if (fstat(item->parent->fd, &staging_parent) != 0 || fstat(target->parent->fd, &target_parent) != 0) {
    fail(&error, errno, "fstat", "Cannot inspect retained replacement parents");
    goto failed;
  }
  name = strdup(target->name);
  if (name == NULL) { fail(&error, ENOMEM, "strdup", "Cannot retain the replacement target name"); goto failed; }
  /* The live management lease coordinates cooperating writers; rename is not an inode CAS. */
  item->publication = INDETERMINATE;
  item->rename_attempted = true;
  item->directory_synced = false;
  int status;
#ifdef __APPLE__
  const char *mechanism = "renameatx_np(flags=0)";
  status = renameatx_np(item->parent->fd, item->staging_name, item->parent->fd, name, 0);
#else
  const char *mechanism = "renameat2(flags=0)";
#ifdef SYS_renameat2
  status = (int)syscall(SYS_renameat2, item->parent->fd, item->staging_name, item->parent->fd, name, 0);
#else
  errno = ENOSYS;
  status = -1;
#endif
#endif
  int rename_error = errno;
  if (status != 0) {
    reconcile_record_replacement(item, target);
    if (fstat(target->fd, &item->replacement_after) == 0) item->replacement_after_known = true;
    if (item->publication == PUBLISHED) { free(item->name); item->name = name; name = NULL; }
    if (item->publication != UNPUBLISHED) target->failed = true;
    fail(&error, rename_error, mechanism, "Private control-record replacement failed; retained bindings were inspected");
    goto failed;
  }
  item->publication = PUBLISHED;
  free(item->name);
  item->name = name;
  name = NULL;
  target->failed = true;
  struct stat current;
  struct stat replaced;
  struct stat parent_after;
  if (fstat(item->fd, &current) != 0 || fstat(target->fd, &replaced) != 0 ||
      fstat(item->parent->fd, &parent_after) != 0) {
    fail(&error, errno, "fstat", "Cannot inspect retained objects after control-record replacement");
    goto failed;
  }
  target->removed = replaced.st_nlink == 0;
  item->replacement_after = replaced;
  item->replacement_after_known = true;
  if (!same_identity(&item->admitted, &current) || !same_security(&item->admitted, &current) ||
      current.st_size != item->admitted.st_size || current.st_nlink != 1 ||
      MTIME(current).tv_sec != MTIME(item->admitted).tv_sec || MTIME(current).tv_nsec != MTIME(item->admitted).tv_nsec ||
      !same_identity(&target->admitted, &replaced) || !same_security(&target->admitted, &replaced) ||
      replaced.st_size != target->admitted.st_size || replaced.st_nlink != 0 ||
      MTIME(replaced).tv_sec != MTIME(target->admitted).tv_sec || MTIME(replaced).tv_nsec != MTIME(target->admitted).tv_nsec) {
    fail(&error, ESTALE, "fstat", "Control-record observations changed during replacement");
    goto failed;
  }
  item->admitted = current;
  if (!validate(item, true, &error) || !validate_lease(lease, &error)) goto failed;
  napi_value facts = facts_value(env, item, &error);
  if (facts == NULL) goto failed;
  napi_value result = object(env);
  boolean_property(env, result, "published", true);
  boolean_property(env, result, "leaseVerified", true);
  text_property(env, result, "mechanism", mechanism);
  property(env, result, "facts", facts);
  property(env, result, "replacedFacts", stat_value(env, &item->replacement_target));
  property(env, result, "replacedAfterFacts", stat_value(env, &replaced));
  property(env, result, "stagingParentFacts", stat_value(env, &staging_parent));
  property(env, result, "targetParentFacts", stat_value(env, &target_parent));
  property(env, result, "parentAfterFacts", stat_value(env, &parent_after));
  return result;
failed:
  if (item->kind == OUTPUT) item->failed = true;
  free(name);
  return throw_failure(env, &error, item, 0);
}

static napi_value remove_unpublished(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], false);
  if (cap == NULL) return NULL;
  resource *item = cap->resource;
  failure error = {0};
  if (item->kind != OUTPUT || item->publication != UNPUBLISHED) {
    fail(&error, EACCES, "unlinkat", "Only an unambiguously unpublished owned staging file can be removed");
    return throw_failure(env, &error, item, 0);
  }
  bool removed = item->removed;
  if (!removed) {
    if (!validate(item->parent, false, &error)) return throw_failure(env, &error, item, 0);
    struct stat current;
    struct stat binding;
    if (fstat(item->fd, &current) != 0) { fail(&error, errno, "fstat", "Cannot inspect staging before removal"); return throw_failure(env, &error, item, 0); }
    if (!same_identity(&item->admitted, &current) || !admit(item, &current, &error)) {
      if (error.number == 0) fail(&error, ESTALE, "fstat", "Staging identity changed");
      return throw_failure(env, &error, item, 0);
    }
    if (fstatat(item->parent->fd, item->staging_name, &binding, AT_SYMLINK_NOFOLLOW) != 0) { fail(&error, errno, "fstatat", "Own staging entry is unavailable"); return throw_failure(env, &error, item, 0); }
    if (!same_identity(&current, &binding) || !literal_spelling(item->parent, item->staging_name, &error)) {
      if (error.number == 0) fail(&error, ESTALE, "fstatat", "Removal withheld because staging binding changed");
      return throw_failure(env, &error, item, 0);
    }
    if (unlinkat(item->parent->fd, item->staging_name, 0) != 0) { fail(&error, errno, "unlinkat", "Cannot remove the verified own staging entry"); return throw_failure(env, &error, item, 0); }
    item->removed = true;
    item->failed = true;
    item->directory_synced = false;
  }
  napi_value result = object(env);
  boolean_property(env, result, "removed", true);
  boolean_property(env, result, "alreadyRemoved", removed);
  boolean_property(env, result, "directorySynced", false);
  return result;
}

static napi_value close_capability(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  capability *cap = get_capability(env, state, values[0], true);
  if (cap == NULL) return NULL;
  resource *item = cap->resource;
  cap->resource = NULL;
  bool already_closed = item == NULL;
  resource observations = {0};
  if (item != NULL) observations = *item;
  int number = item == NULL ? 0 : release_resource(item);
  if (number != 0) { failure error = {.number = number, .syscall = "close", .message = "Resource was invalidated before an uncertain close failure"}; return throw_failure(env, &error, &observations, 0); }
  napi_value result = object(env);
  boolean_property(env, result, "closed", true);
  boolean_property(env, result, "alreadyClosed", already_closed);
  return result;
}

static napi_value throw_process_observation(napi_env env, int pid, int number,
                                            const char *syscall, const char *reason,
                                            const char *message) {
  napi_value result;
  check(napi_create_error(env, string(env, errno_name(number)), string(env, message), &result));
  number_property(env, result, "errno", number);
  number_property(env, result, "pid", pid);
  text_property(env, result, "syscall", syscall);
  text_property(env, result, "reason", reason);
  boolean_property(env, result, "observationOnly", true);
  /* A failed snapshot is never a retained process-exit observation. */
  boolean_property(env, result, "exitConfirmed", false);
  check(napi_throw(env, result));
  return NULL;
}

#ifdef __APPLE__
static bool observe_boot_session(char result[37], failure *error) {
  size_t size = 37;
  memset(result, 0, size);
  errno = 0;
  if (sysctlbyname("kern.bootsessionuuid", result, &size, NULL, 0) != 0) {
    return fail(error, errno == 0 ? EIO : errno, "sysctlbyname(kern.bootsessionuuid)", "Cannot observe the kernel boot-session identity");
  }
  if (size != 37 || result[36] != '\0') return fail(error, ENOTSUP, "sysctlbyname(kern.bootsessionuuid)", "Kernel boot-session identity is not a complete UUID");
  bool nonzero = false;
  for (size_t index = 0; index < 36; ++index) {
    if (index == 8 || index == 13 || index == 18 || index == 23) {
      if (result[index] != '-') return fail(error, ENOTSUP, "sysctlbyname(kern.bootsessionuuid)", "Kernel boot-session UUID is malformed");
      continue;
    }
    char value = result[index];
    if (value >= 'A' && value <= 'F') value = (char)(value + ('a' - 'A'));
    if (!((value >= '0' && value <= '9') || (value >= 'a' && value <= 'f'))) return fail(error, ENOTSUP, "sysctlbyname(kern.bootsessionuuid)", "Kernel boot-session UUID is malformed");
    result[index] = value;
    if (value != '0') nonzero = true;
  }
  return nonzero || fail(error, ENOTSUP, "sysctlbyname(kern.bootsessionuuid)", "Kernel boot-session identity is unavailable");
}

static bool observe_owned_process(int pid, pid_t observer, uid_t owner,
                                   struct proc_bsdinfo *facts, failure *error,
                                   const char **reason) {
  memset(facts, 0, sizeof(*facts));
  errno = 0;
  int received = proc_pidinfo(pid, PROC_PIDTBSDINFO, 0, facts, (int)sizeof(*facts));
  if (received != (int)sizeof(*facts)) {
    int number = received <= 0 && errno != 0 ? errno : EIO;
    *reason = number == ESRCH ? "process-unavailable" : "observation-failed";
    return fail(error, number, "proc_pidinfo(PROC_PIDTBSDINFO)", "Cannot obtain complete process ownership observations");
  }
  if (facts->pbi_pid != (uint32_t)pid) {
    *reason = "identity-changed";
    return fail(error, ESTALE, "proc_pidinfo(PROC_PIDTBSDINFO)", "Observed process identity does not match the requested PID");
  }
  if (facts->pbi_uid != owner || (pid != observer && facts->pbi_ppid != (uint32_t)observer)) {
    *reason = "scope-refused";
    return fail(error, EACCES, "proc_pidinfo(PROC_PIDTBSDINFO)", "Only the current process or its direct same-owner child can be observed");
  }
  if ((facts->pbi_flags & PROC_FLAG_INEXIT) != 0) {
    *reason = "process-exiting";
    return fail(error, ESRCH, "proc_pidinfo(PROC_PIDTBSDINFO)", "The kernel observed the process in exit; no exit watcher is held");
  }
  return true;
}

static bool observe_process_usage(int pid, struct rusage_info_v0 *facts,
                                   failure *error, const char **reason) {
  memset(facts, 0, sizeof(*facts));
  errno = 0;
  if (proc_pid_rusage(pid, RUSAGE_INFO_V0, (rusage_info_t *)facts) != 0) {
    int number = errno == 0 ? EIO : errno;
    *reason = number == ESRCH ? "process-unavailable" : "observation-failed";
    return fail(error, number, "proc_pid_rusage(RUSAGE_INFO_V0)", "Cannot obtain kernel process-birth observations");
  }
  if (facts->ri_proc_exit_abstime != 0) {
    *reason = "process-exiting";
    return fail(error, ESRCH, "proc_pid_rusage(RUSAGE_INFO_V0)", "The kernel reported an exited process; no retained exit observation is provided");
  }
  if (facts->ri_proc_start_abstime == 0) {
    *reason = "observation-failed";
    return fail(error, ENOTSUP, "proc_pid_rusage(RUSAGE_INFO_V0)", "Kernel process-birth absolute time is unavailable");
  }
  return true;
}
#endif

static napi_value observe_process_birth(napi_env env, napi_callback_info info) {
  napi_value values[1];
  owner *state = arguments(env, info, 1, values);
  if (state == NULL) return NULL;
  double requested;
  if (napi_get_value_double(env, values[0], &requested) != napi_ok || !(requested >= 1 && requested <= INT_MAX) || requested != (double)(int)requested) return invalid(env, "Process ID must be a positive bounded integer");
  int pid = (int)requested;
#ifndef __APPLE__
  return throw_process_observation(env, pid, ENOTSUP, "proc_pid_rusage(RUSAGE_INFO_V0)", "unsupported-platform", "Kernel process-birth observation is supported only on Darwin");
#else
  pid_t observer = getpid();
  uid_t uid = geteuid();
  struct proc_bsdinfo before;
  struct proc_bsdinfo after;
  struct rusage_info_v0 birth_before;
  struct rusage_info_v0 birth_after;
  char boot_before[37];
  char boot_after[37];
  failure error = {0};
  const char *reason = "boot-identity-unavailable";
  if (!observe_boot_session(boot_before, &error)) goto failed;
  if (!observe_owned_process(pid, observer, uid, &before, &error, &reason)) goto failed;
  if (!observe_process_usage(pid, &birth_before, &error, &reason) ||
      !observe_process_usage(pid, &birth_after, &error, &reason)) goto failed;
  if (!observe_owned_process(pid, observer, uid, &after, &error, &reason)) goto failed;
  if (before.pbi_pid != after.pbi_pid || before.pbi_ppid != after.pbi_ppid ||
      before.pbi_uid != after.pbi_uid || before.pbi_ruid != after.pbi_ruid || before.pbi_svuid != after.pbi_svuid ||
      before.pbi_start_tvsec != after.pbi_start_tvsec || before.pbi_start_tvusec != after.pbi_start_tvusec ||
      birth_before.ri_proc_start_abstime != birth_after.ri_proc_start_abstime || observer != getpid() || uid != geteuid()) {
    reason = "identity-changed";
    fail(&error, ESTALE, "proc_pid_rusage(RUSAGE_INFO_V0)", "Kernel process identity or ownership observations changed");
    goto failed;
  }
  reason = "boot-identity-unavailable";
  if (!observe_boot_session(boot_after, &error)) goto failed;
  if (strcmp(boot_before, boot_after) != 0) {
    reason = "identity-changed";
    fail(&error, ESTALE, "sysctlbyname(kern.bootsessionuuid)", "Kernel boot-session observations changed");
    goto failed;
  }
  napi_value result = object(env);
  text_property(env, result, "platform", "darwin");
  number_property(env, result, "pid", pid);
  number_property(env, result, "parentPid", after.pbi_ppid);
  unsigned_property(env, result, "uid", (uintmax_t)after.pbi_uid);
  text_property(env, result, "scope", pid == observer ? "current-process" : "direct-child");
  text_property(env, result, "mechanism", "proc_pid_rusage(RUSAGE_INFO_V0)");
  unsigned_property(env, result, "startAbstime", birth_after.ri_proc_start_abstime);
  text_property(env, result, "bootSessionUuid", boot_after);
  boolean_property(env, result, "observationOnly", true);
  return result;
failed:
  return throw_process_observation(env, pid, error.number, error.syscall, reason, error.message);
#endif
}

static napi_value initialize(napi_env env, napi_value exports) {
  owner *state = calloc(1, sizeof(*state));
  if (state == NULL) { failure error = {.number = ENOMEM, .syscall = "calloc", .message = "Cannot allocate environment resource owner"}; return throw_failure(env, &error, NULL, 0); }
  state->env = env;
  state->refs = 1;
  napi_status status = napi_add_env_cleanup_hook(env, cleanup_environment, state);
  if (status != napi_ok) { free(state); check(status); }
  napi_property_descriptor descriptors[] = {
    {"observeProcessBirth", NULL, observe_process_birth, NULL, NULL, NULL, napi_default, state},
    {"openDirectory", NULL, open_directory, NULL, NULL, NULL, napi_default, state},
    {"openChild", NULL, open_child, NULL, NULL, NULL, napi_default, state},
    {"createPrivateChild", NULL, create_private_child, NULL, NULL, NULL, napi_default, state},
    {"listDirectory", NULL, list_directory, NULL, NULL, NULL, napi_default, state},
    {"listSourceDirectory", NULL, list_source_directory, NULL, NULL, NULL, napi_default, state},
    {"observeCapacity", NULL, observe_capacity, NULL, NULL, NULL, napi_default, state},
    {"openSource", NULL, open_source, NULL, NULL, NULL, napi_default, state},
    {"inspectSourceLink", NULL, inspect_source_link, NULL, NULL, NULL, napi_default, state},
    {"openPrivateRecord", NULL, open_private_record, NULL, NULL, NULL, napi_default, state},
    {"openPrivateOutput", NULL, open_private_output, NULL, NULL, NULL, napi_default, state},
    {"acquireLease", NULL, acquire_lease, NULL, NULL, NULL, napi_default, state},
    {"createFile", NULL, create_file, NULL, NULL, NULL, napi_default, state},
    {"inspect", NULL, inspect, NULL, NULL, NULL, napi_default, state},
    {"inspectBinding", NULL, inspect_directory_binding, NULL, NULL, NULL, napi_default, state},
    {"inspectFileBinding", NULL, inspect_file_binding, NULL, NULL, NULL, napi_default, state},
    {"read", NULL, read_chunk, NULL, NULL, NULL, napi_default, state},
    {"write", NULL, write_chunk, NULL, NULL, NULL, napi_default, state},
    {"setExecutable", NULL, set_executable, NULL, NULL, NULL, napi_default, state},
    {"syncFile", NULL, sync_file, NULL, NULL, NULL, napi_default, state},
    {"syncDirectory", NULL, sync_directory, NULL, NULL, NULL, napi_default, state},
    {"publish", NULL, publish, NULL, NULL, NULL, napi_default, state},
    {"replacePrivateRecord", NULL, replace_private_record, NULL, NULL, NULL, napi_default, state},
    {"removeUnpublished", NULL, remove_unpublished, NULL, NULL, NULL, napi_default, state},
    {"close", NULL, close_capability, NULL, NULL, NULL, napi_default, state},
  };
  check(napi_define_properties(env, exports, sizeof(descriptors) / sizeof(descriptors[0]), descriptors));
  return exports;
}

NAPI_MODULE(NODE_GYP_MODULE_NAME, initialize)
