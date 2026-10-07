/* Linux fixture: mutate only an explicitly armed owned directory during observation. */
#define _GNU_SOURCE
#include <dirent.h>
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdbool.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>

static void mutate(int fd, bool listing) {
  static unsigned int capacity_calls;
  static bool changed;
  const char *mode = getenv("PRIVATE_STORAGE_DIRECTORY_FAULT_MODE");
  const char *dev = getenv("PRIVATE_STORAGE_DIRECTORY_FAULT_DEV");
  const char *ino = getenv("PRIVATE_STORAGE_DIRECTORY_FAULT_INO");
  struct stat stat;
  if (changed || mode == NULL || dev == NULL || ino == NULL || fstat(fd, &stat) != 0 ||
      (uintmax_t)stat.st_dev != strtoull(dev, NULL, 10) ||
      (uintmax_t)stat.st_ino != strtoull(ino, NULL, 10)) return;
  if (listing ? strcmp(mode, "list-mutation") != 0 : strcmp(mode, "capacity-mutation") != 0) return;
  if (!listing && ++capacity_calls != 3) return;
  int number = errno;
  int created = openat(fd, "native-observation-mutation", O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
  if (created >= 0) { changed = true; (void)close(created); }
  errno = number;
}

struct dirent *readdir(DIR *stream) {
  static struct dirent *(*original)(DIR *);
  if (original == NULL) original = dlsym(RTLD_NEXT, "readdir");
  struct dirent *result = original(stream);
  if (result != NULL && strcmp(result->d_name, ".") != 0 && strcmp(result->d_name, "..") != 0) mutate(dirfd(stream), true);
  return result;
}

#ifdef __GLIBC__
struct dirent64 *readdir64(DIR *stream) {
  static struct dirent64 *(*original)(DIR *);
  if (original == NULL) original = dlsym(RTLD_NEXT, "readdir64");
  struct dirent64 *result = original(stream);
  if (result != NULL && strcmp(result->d_name, ".") != 0 && strcmp(result->d_name, "..") != 0) mutate(dirfd(stream), true);
  return result;
}
#endif

int fstatvfs(int fd, struct statvfs *facts) {
  static int (*original)(int, struct statvfs *);
  if (original == NULL) original = dlsym(RTLD_NEXT, "fstatvfs");
  int result = original(fd, facts);
  if (result == 0) mutate(fd, false);
  return result;
}

#ifdef __GLIBC__
int fstatvfs64(int fd, struct statvfs64 *facts) {
  static int (*original)(int, struct statvfs64 *);
  if (original == NULL) original = dlsym(RTLD_NEXT, "fstatvfs64");
  int result = original(fd, facts);
  if (result == 0) mutate(fd, false);
  return result;
}
#endif
