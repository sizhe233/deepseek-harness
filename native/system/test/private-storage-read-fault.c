/* Linux LD_PRELOAD fixture: target only the parent's owned synthetic source inode. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

ssize_t read(int fd, void *buffer, size_t length) {
  static ssize_t (*original)(int, void *, size_t);
  static unsigned int calls;
  if (original == NULL) original = dlsym(RTLD_NEXT, "read");
  const char *dev = getenv("PRIVATE_STORAGE_FAULT_DEV");
  const char *ino = getenv("PRIVATE_STORAGE_FAULT_INO");
  const char *mode = getenv("PRIVATE_STORAGE_FAULT_MODE");
  struct stat stat;
  if (dev == NULL || ino == NULL || mode == NULL || fstat(fd, &stat) != 0 ||
      (uintmax_t)stat.st_dev != strtoull(dev, NULL, 10) ||
      (uintmax_t)stat.st_ino != strtoull(ino, NULL, 10)) return original(fd, buffer, length);
  ++calls;
  if (strcmp(mode, "eintr") == 0 && calls == 1) { errno = EINTR; return -1; }
  if (strcmp(mode, "zero") == 0 && calls == 1) return 0;
  if (strcmp(mode, "partial-error") == 0 && calls > 1) { errno = EIO; return -1; }
  if ((strcmp(mode, "short") == 0 || strcmp(mode, "partial-error") == 0) && length > 2) length = 2;
  return original(fd, buffer, length);
}
