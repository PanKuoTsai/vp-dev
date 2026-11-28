/*
 * vplogger: the program of the VP Studio tutorial ("Create Tutorial Workspace").
 *
 * It simulates a set of sensors, filters their samples and appends one line
 * per record to a log file. Three builds of this one file are shipped:
 *
 *   vplogger-bug   (no flags)       sensor 5 goes offline at record 3000; the
 *                                   loop does not check for that and crashes
 *                                   (Segmentation fault). Every line is also
 *                                   written with its own write() and fsync().
 *   vplogger-fix1  (-DFIX_OFFLINE)  skips offline sensors; still one write()
 *                                   and one fsync() per line (slow).
 *   vplogger-fix2  (-DFIX_OFFLINE -DFIX_BUFFERED)
 *                                   collects lines in a 64 KiB buffer and
 *                                   writes it when full; one fsync() at the end.
 *
 * usage: vplogger [-n sensors] [-r records] [-o file]
 *   defaults: 8 sensors, 6000 records, /tmp/vplogger.log
 *
 * Build (on the host, see build.sh): aarch64-linux-gnu-gcc -std=gnu11 -O1 -g
 *   -fno-omit-frame-pointer -no-pie ... (non-PIE: the symbols are at the
 *   addresses the debugger and the profiler show, without a load offset).
 *   The debug information names this file /vplogger/vplogger.c; the
 *   tutorial workspace maps /vplogger to its own copy of this folder.
 */
#include <errno.h>
#include <fcntl.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define MAX_SENSORS 16
#define OFFLINE_SENSOR 5
#define OFFLINE_AT 3000
#define TAPS 16

struct sensor;

struct sensor_ops {
    const char *kind;
    int32_t (*read)(struct sensor *s, uint32_t tick);
};

struct sensor {
    const struct sensor_ops *ops; /* offset 0: what the crash reads */
    uint32_t id;
    uint32_t seed;
    int32_t history[TAPS];        /* the filter's last samples */
    uint32_t pos;
};

static struct sensor *sensors[MAX_SENSORS];
static unsigned n_sensors = 8;

/* A cheap pseudo-random signal: a slow ramp plus noise, per sensor. */
static int32_t temp_read(struct sensor *s, uint32_t tick)
{
    s->seed = s->seed * 1103515245u + 12345u;
    return (int32_t)(2000 + (tick % 500) + s->id * 10 + ((s->seed >> 16) & 0x3f));
}

static int32_t pressure_read(struct sensor *s, uint32_t tick)
{
    s->seed ^= s->seed << 13;
    s->seed ^= s->seed >> 17;
    s->seed ^= s->seed << 5;
    return (int32_t)(101300 + ((tick * 7) % 200) - (int32_t)(s->seed & 0xff));
}

static const struct sensor_ops temp_ops = { "temp", temp_read };
static const struct sensor_ops pressure_ops = { "pressure", pressure_read };

/* A moving average over the last TAPS samples: the user-space work. */
static __attribute__((noinline)) int32_t filter(struct sensor *s, int32_t v)
{
    s->history[s->pos++ % TAPS] = v;
    int64_t sum = 0;
    for (unsigned k = 0; k < TAPS; k++) sum += s->history[k];
    return (int32_t)(sum / TAPS);
}

/* The sensor stops answering: its driver frees it. */
static void sensor_offline(unsigned i)
{
    free(sensors[i]);
    sensors[i] = NULL;
}

static __attribute__((noinline)) int format_record(char *line, size_t room, uint32_t tick)
{
    int n = snprintf(line, room, "t=%u", tick);
    for (unsigned i = 0; i < n_sensors; i++) {
        struct sensor *s = sensors[i];
#ifdef FIX_OFFLINE
        if (!s) {
            n += snprintf(line + n, room - n, " s%u=--", i);
            continue;
        }
#endif
        int32_t v = filter(s, s->ops->read(s, tick));
        n += snprintf(line + n, room - n, " %s%u=%d", s->ops->kind, i, v);
    }
    n += snprintf(line + n, room - n, "\n");
    return n;
}

static __attribute__((noinline)) void write_all(int fd, const char *p, size_t len)
{
    while (len) {
        ssize_t w = write(fd, p, len);
        if (w < 0) {
            if (errno == EINTR) continue;
            perror("write");
            exit(1);
        }
        p += w;
        len -= (size_t)w;
    }
}

int main(int argc, char **argv)
{
    unsigned records = 6000;
    const char *out = "/tmp/vplogger.log";
    int c;
    while ((c = getopt(argc, argv, "n:r:o:")) != -1) {
        if (c == 'n') n_sensors = (unsigned)atoi(optarg);
        else if (c == 'r') records = (unsigned)atoi(optarg);
        else if (c == 'o') out = optarg;
        else {
            fprintf(stderr, "usage: %s [-n sensors] [-r records] [-o file]\n", argv[0]);
            return 2;
        }
    }
    if (n_sensors < 1 || n_sensors > MAX_SENSORS) {
        fprintf(stderr, "sensors: 1 to %d\n", MAX_SENSORS);
        return 2;
    }
    for (unsigned i = 0; i < n_sensors; i++) {
        struct sensor *s = calloc(1, sizeof *s);
        s->ops = (i % 2) ? &pressure_ops : &temp_ops;
        s->id = i;
        s->seed = 0x1234567u + i * 77u;
        sensors[i] = s;
    }
    int fd = open(out, O_WRONLY | O_CREAT | O_TRUNC, 0644);
    if (fd < 0) {
        perror(out);
        return 1;
    }
#ifdef FIX_BUFFERED
    static char buf[64 * 1024];
    size_t used = 0;
#endif
    char line[1024];
    printf("vplogger: %u sensors, %u records -> %s\n", n_sensors, records, out);
    fflush(stdout);
    for (uint32_t tick = 0; tick < records; tick++) {
        if (tick == OFFLINE_AT && n_sensors > OFFLINE_SENSOR) sensor_offline(OFFLINE_SENSOR);
        int n = format_record(line, sizeof line, tick);
#ifdef FIX_BUFFERED
        if (used + (size_t)n > sizeof buf) {
            write_all(fd, buf, used);
            used = 0;
        }
        memcpy(buf + used, line, (size_t)n);
        used += (size_t)n;
#else
        write_all(fd, line, (size_t)n);
        fsync(fd); /* make sure every record is on the disk */
#endif
        if ((tick + 1) % 1000 == 0) {
            printf("vplogger: %u records\n", tick + 1);
            fflush(stdout);
        }
    }
#ifdef FIX_BUFFERED
    write_all(fd, buf, used);
    fsync(fd);
#endif
    close(fd);
    printf("vplogger: done, %u records\n", records);
    return 0;
}
