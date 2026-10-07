/* Independent syscall diagnostics. This is not a provider admission bypass. */
#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdbool.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef __APPLE__
#include <membership.h>
#include <sys/acl.h>
#include <sys/mount.h>
#else
#include <sys/syscall.h>
#include <sys/vfs.h>
#endif

static void require(bool condition, const char *operation) {
  if (condition) return;
  fprintf(stderr, "%s: %s\n", operation, strerror(errno));
  exit(1);
}

static int publish(int parent, const char *source, const char *target) {
#ifdef __APPLE__
  return renameatx_np(parent, source, parent, target, RENAME_EXCL);
#elif defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, parent, source, parent, target, 1);
#else
  errno = ENOSYS;
  return -1;
#endif
}

static int replace_record(int parent, const char *source, const char *target) {
#ifdef __APPLE__
  return renameatx_np(parent, source, parent, target, 0);
#elif defined(SYS_renameat2)
  return (int)syscall(SYS_renameat2, parent, source, parent, target, 0);
#else
  errno = ENOSYS;
  return -1;
#endif
}

#ifdef __APPLE__
static void observe_acl(int fd, bool expected_present) {
  filesec_t security = filesec_init();
  require(security != NULL, "allocate ACL observation");
  struct stat observed;
  require(fstatx_np(fd, &observed, security) == 0, "observe retained ACL property");
  int present = 0;
  require(filesec_query_property(security, FILESEC_ACL, &present) == 0, "query retained ACL property");
  require((present != 0) == expected_present, "expected retained ACL presence");
  if (present) {
    acl_t acl = NULL;
    require(filesec_get_property(security, FILESEC_ACL, &acl) == 0 && acl != NULL, "copy present ACL");
    filesec_free(security);
    require(acl_valid(acl) == 0, "validate present ACL");
    acl_entry_t entry;
    require(acl_get_entry(acl, ACL_FIRST_ENTRY, &entry) == 0, "observe one ACL entry");
    errno = 0;
    require(acl_get_entry(acl, ACL_NEXT_ENTRY, &entry) < 0 && errno == EINVAL, "observe ACL enumeration end");
    require(acl_free(acl) == 0, "release copied ACL");
  } else {
    filesec_free(security);
  }
}

static void darwin_acl_probe(int parent) {
  uuid_t owner;
  require(mbr_uid_to_uuid(geteuid(), owner) == 0, "resolve fixture owner UUID");
  acl_t acl = acl_init(1);
  require(acl != NULL, "allocate owned fixture ACL");
  acl_entry_t entry;
  acl_permset_t permissions;
  require(acl_create_entry(&acl, &entry) == 0, "create owned fixture ACL entry");
  require(acl_set_tag_type(entry, ACL_EXTENDED_ALLOW) == 0, "set owned fixture ACL tag");
  require(acl_set_qualifier(entry, owner) == 0, "set owned fixture ACL owner");
  require(acl_get_permset(entry, &permissions) == 0 && acl_add_perm(permissions, ACL_READ_DATA) == 0,
          "set owned fixture ACL read permission");
  require(acl_valid(acl) == 0, "validate owned fixture ACL");
  const char *names[] = {"oracle-no-acl", "oracle-with-acl", "oracle-no-acl-directory", "oracle-with-acl-directory"};
  for (size_t index = 0; index < sizeof(names) / sizeof(names[0]); ++index) {
    bool directory = index >= 2;
    bool present = (index % 2) != 0;
    if (directory) require(mkdirat(parent, names[index], 0700) == 0, "create owned ACL fixture directory");
    int fd = openat(parent, names[index], O_NOFOLLOW | O_CLOEXEC |
                    (directory ? O_RDONLY | O_DIRECTORY : O_RDWR | O_CREAT | O_EXCL), 0600);
    require(fd >= 0, "open owned ACL fixture");
    if (!directory) require(write(fd, "acl", 3) == 3, "write owned ACL fixture");
    if (present) {
      require(acl_set_fd_np(fd, acl, ACL_TYPE_EXTENDED) == 0, "set owned fixture extended ACL");
    } else {
      filesec_t removal = filesec_init();
      require(removal != NULL, "allocate owned fixture ACL removal");
      require(filesec_set_property(removal, FILESEC_ACL, _FILESEC_REMOVE_ACL) == 0,
              "request removal of owned fixture ACL");
      require(fchmodx_np(fd, removal) == 0, "remove owned fixture ACL");
      filesec_free(removal);
    }
    observe_acl(fd, present);
    require(close(fd) == 0, "close owned ACL fixture");
  }
  require(acl_free(acl) == 0, "release owned fixture ACL");
  filesec_t security = filesec_init();
  require(security != NULL, "allocate invalid-fd ACL observation");
  struct stat observed;
  errno = 0;
  require(fstatx_np(-1, &observed, security) < 0 && errno == EBADF, "refuse invalid-fd ACL observation");
  filesec_free(security);
}
#endif

int main(int argc, char **argv) {
  require(argc == 2, "owned fixture directory argument");
  int parent = open(argv[1], O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
  require(parent >= 0, "open owned fixture directory");
  struct statfs filesystem;
  require(fstatfs(parent, &filesystem) == 0, "fstatfs");
  int first = openat(parent, "oracle-first", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  require(first >= 0, "openat first staging");
  int second = openat(parent, "oracle-second", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  require(second >= 0, "openat second staging");
  require(write(first, "first", 5) == 5, "write first staging");
  require(write(second, "other", 5) == 5, "write second staging");
  require(fsync(first) == 0, "fsync first staging");
  require(fsync(second) == 0, "fsync second staging");
#ifdef __APPLE__
  require(fcntl(first, F_FULLFSYNC) == 0, "full sync first staging");
#endif
  struct stat before;
  struct stat final;
  struct stat retained;
  require(fstat(first, &before) == 0, "fstat before publish");
  require(publish(parent, "oracle-first", "oracle-final") == 0, "exclusive publish");
  require(publish(parent, "oracle-second", "oracle-final") < 0 && errno == EEXIST, "exclusive collision refusal");
  require(fsync(parent) == 0, "fsync retained parent");
#ifdef __APPLE__
  require(fcntl(first, F_FULLFSYNC) == 0, "post-directory full sync");
#endif
  require(fstatat(parent, "oracle-final", &final, AT_SYMLINK_NOFOLLOW) == 0, "fstatat final");
  require(fstat(first, &retained) == 0, "fstat retained output");
  require(before.st_dev == final.st_dev && before.st_ino == final.st_ino && final.st_dev == retained.st_dev && final.st_ino == retained.st_ino, "retained final identity");
  require(fstat(second, &retained) == 0, "fstat own unpublished staging");
  require(fstatat(parent, "oracle-second", &before, AT_SYMLINK_NOFOLLOW) == 0, "fstatat own unpublished staging");
  require(retained.st_dev == before.st_dev && retained.st_ino == before.st_ino, "own staging identity");
  require(unlinkat(parent, "oracle-second", 0) == 0, "unlink own unpublished staging");
  require(fsync(parent) == 0, "fsync explicit cleanup");
  int lease = openat(parent, "oracle-lock", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  require(lease >= 0, "open owned management lock");
  require(flock(lease, LOCK_EX | LOCK_NB) == 0, "acquire nonblocking management lock");
  int contender = openat(parent, "oracle-lock", O_RDWR | O_NOFOLLOW | O_CLOEXEC);
  require(contender >= 0, "open contender management lock");
  require(flock(contender, LOCK_EX | LOCK_NB) < 0 && (errno == EAGAIN || errno == EWOULDBLOCK), "management lock contention");
  int old_record = openat(parent, "oracle-control", O_RDWR | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  int new_record = openat(parent, "oracle-control-staging", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  require(old_record >= 0 && new_record >= 0, "create owned control records");
  require(write(old_record, "prior", 5) == 5 && write(new_record, "after", 5) == 5, "write small control records");
  require(fsync(new_record) == 0, "synchronize replacement record");
#ifdef __APPLE__
  require(fcntl(new_record, F_FULLFSYNC) == 0, "full sync replacement record");
#endif
  require(fstat(old_record, &before) == 0, "observe old control record");
  require(replace_record(parent, "oracle-control-staging", "oracle-control") == 0, "relative control record replacement");
  require(fsync(parent) == 0, "synchronize replacement directory");
#ifdef __APPLE__
  require(fcntl(new_record, F_FULLFSYNC) == 0, "post-directory replacement full sync");
#endif
  require(fstat(old_record, &retained) == 0, "observe replaced retained record");
  require(retained.st_ino == before.st_ino && retained.st_dev == before.st_dev && retained.st_nlink == 0, "old control record retained and unlinked");
  char old_bytes[5];
  require(pread(old_record, old_bytes, sizeof(old_bytes), 0) == 5 && memcmp(old_bytes, "prior", 5) == 0, "old control record bytes preserved");
  require(fstat(new_record, &retained) == 0 && fstatat(parent, "oracle-control", &final, AT_SYMLINK_NOFOLLOW) == 0, "observe replacement binding");
  require(retained.st_ino == final.st_ino && retained.st_dev == final.st_dev, "new control record bound at final name");
  require(fstat(lease, &before) == 0, "observe management lock identity");
  require(close(lease) == 0, "close management lease");
  require(flock(contender, LOCK_EX | LOCK_NB) == 0, "acquire management lease after close");
  require(fstatat(parent, "oracle-lock", &final, AT_SYMLINK_NOFOLLOW) == 0 && final.st_ino == before.st_ino && final.st_dev == before.st_dev, "management lock entry remains unchanged");
  require(close(contender) == 0, "close contender");
  require(close(old_record) == 0 && close(new_record) == 0, "close control records");
  require(close(first) == 0, "close first");
  require(close(second) == 0, "close second");
#ifdef __APPLE__
  darwin_acl_probe(parent);
  const char *darwin_acl = "{\"absentFileObserved\":true,\"absentDirectoryObserved\":true,\"presentFileObserved\":true,\"presentDirectoryObserved\":true,\"invalidDescriptorRefused\":true}";
#else
  const char *darwin_acl = "null";
#endif
  require(close(parent) == 0, "close parent");
  printf("{\"kind\":\"independent-syscall-diagnostic\",\"filesystemType\":\"%" PRIuMAX "\",\"exclusivePublication\":true,\"collisionPreserved\":true,\"sameFdFinalBinding\":true,\"fileSyncObserved\":true,\"directorySyncObserved\":true,\"nonblockingLeaseObserved\":true,\"retainedRecordReplacement\":true,\"providerAcceptance\":false,\"persistentLocalAcceptance\":false,\"nativeDurabilityClaimed\":false,\"darwinAcl\":%s}\n", (uintmax_t)filesystem.f_type, darwin_acl);
  return 0;
}
