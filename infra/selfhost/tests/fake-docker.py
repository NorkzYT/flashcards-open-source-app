#!/usr/bin/env python3
"""Recording fake of the `docker` CLI for backup-restore-safety.sh. Never talks to a daemon.

State lives next to the fake socket named by DOCKER_HOST (unix://<state-dir>/docker.sock), so the
scrubbed environment the scripts use is enough to find it, and a call without that exact endpoint
fails. Every call is appended to <state-dir>/calls.log as one JSON line (argv, environment variable
names, DOCKER_HOST). `docker run` executes the requested tar/sh command locally with /data mapped to
<state-dir>/volumes/<volume>, so the archive and checksum logic under test is real.
"""
import fcntl
import json
import os
import re
import subprocess
import sys

host = os.environ.get("DOCKER_HOST", "")
if not host.startswith("unix://"):
    sys.stderr.write("fake-docker: no explicit unix DOCKER_HOST\n")
    sys.exit(97)
SD = os.path.dirname(host[len("unix://"):])
STATE = os.path.join(SD, "state.json")
if not os.path.exists(STATE):
    sys.stderr.write("fake-docker: unknown endpoint %s\n" % host)
    sys.exit(97)

lock = open(os.path.join(SD, "lock"), "w")
fcntl.flock(lock, fcntl.LOCK_EX)
with open(STATE) as fh:
    st = json.load(fh)
with open(os.path.join(SD, "calls.log"), "a") as fh:
    fh.write(json.dumps({"argv": sys.argv[1:], "env": sorted(os.environ), "docker_host": host}) + "\n")

beh = st.setdefault("behavior", {})


def save():
    with open(STATE, "w") as fh:
        json.dump(st, fh, indent=1)


def done(rc=0):
    save()
    sys.exit(rc)


def fail(msg, rc=1):
    sys.stderr.write("fake-docker: %s\n" % msg)
    done(rc)


def labels_of(c):
    return {
        "com.docker.compose.project": c["project"],
        "com.docker.compose.service": c["service"],
        "com.docker.compose.oneoff": c.get("oneoff", "False"),
        "com.docker.compose.project.config_files": c.get("config_files", ""),
        "com.docker.compose.project.environment_file": c.get("env_file", ""),
    }


def render_container(fmt, c):
    health = c.get("health")
    s = fmt.replace("{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}", health or "none")
    s = s.replace("{{.State.Status}}", c["state"]).replace("{{.State}}", c["state"])
    s = s.replace("{{.ID}}", c["id"]).replace("{{.Image}}", c.get("image", "sha256:img"))
    s = re.sub(r'\{\{\.Label "([^"]+)"\}\}', lambda m: labels_of(c).get(m.group(1), ""), s)
    return s


def render_network(fmt, name, n):
    s = fmt.replace("{{range .IPAM.Config}}{{.Subnet}},{{end}}", "".join(x + "," for x in n.get("subnets", [])))
    s = s.replace("{{.Name}}", name).replace("{{.Internal}}", "true" if n.get("internal") else "false")
    s = re.sub(r'\{\{index \.Labels "([^"]+)"\}\}', lambda m: n.get("labels", {}).get(m.group(1), ""), s)
    return s


def take(args, flag):
    """Removes every `flag value` pair and returns the values."""
    out, rest, i = [], [], 0
    while i < len(args):
        if args[i] == flag:
            out.append(args[i + 1])
            i += 2
        else:
            rest.append(args[i])
            i += 1
    args[:] = rest
    return out


def match_label(labels, f):
    k, _, v = f.partition("=")
    return k in labels and (not _ or labels[k] == v)


def ps(args):
    filters = take(args, "--filter")
    fmt = (take(args, "--format") or ["{{.ID}}"])[0]
    show_all = "-a" in args or "-aq" in args
    quiet = "-q" in args or "-aq" in args
    for c in st["containers"]:
        if not show_all and c["state"] != "running":
            continue
        ok = True
        for f in filters:
            kind, _, val = f.partition("=")
            if kind == "label":
                ok = ok and match_label(labels_of(c), val)
            elif kind == "volume":
                ok = ok and val in c.get("mounts", [])
            elif kind == "status":
                ok = ok and c["state"] == val
        if ok:
            print(c["id"] if quiet else render_container(fmt, c))
    done()


def new_id(service):
    st["seq"] = st.get("seq", 0) + 1
    return ("%012x" % (0xC0FFEE000000 + st["seq"]))


def compose(args):
    project = take(args, "-p")[0]
    env_file = take(args, "--env-file")[0]
    files = take(args, "-f")
    take(args, "--profile")
    sub, rest = args[0], args[1:]
    cfiles = ",".join(files)
    mine = [c for c in st["containers"] if c["project"] == project and c.get("oneoff", "False") == "False"]
    if sub == "ps":
        services = [a for a in rest if not a.startswith("-")]
        for c in mine:
            if services and c["service"] not in services:
                continue
            if "-a" not in rest and "-aq" not in rest and c["state"] != "running":
                continue
            print(c["id"])
        done()
    if sub == "stop":
        for c in mine:
            if c["service"] in rest and c["service"] not in beh.get("stop_ignored", []):
                c["state"] = "exited"
        done()
    if sub == "start":
        rc = 0
        for c in mine:
            if c["service"] in rest:
                if c["service"] in beh.get("fail_start", []):
                    sys.stderr.write("fake-docker: container %s failed to start\n" % c["service"])
                    rc = 1
                else:
                    c["state"] = "running"
        done(rc)
    if sub == "create":
        for key in ("pgdata", "objectdata"):
            name = "%s_%s" % (project, key)
            st["volumes"].setdefault(name, {"labels": {"com.docker.compose.project": project, "com.docker.compose.volume": key}})
            os.makedirs(os.path.join(SD, "volumes", name), exist_ok=True)
            if key in beh.get("preseed_new_volume", []):
                with open(os.path.join(SD, "volumes", name, "leftover"), "w") as fh:
                    fh.write("x")
        # Subnets from an IPAM overlay (the last -f when it is not a shipped compose*.yml).
        subnets, net = {}, None
        for f in files:
            if os.path.basename(f).startswith("compose"):
                continue
            for line in open(f):
                m = re.match(r"^  ([a-z]+):$", line)
                if m:
                    net = m.group(1)
                m = re.match(r"^ +- subnet: (\S+)$", line)
                if m:
                    subnets[net] = [m.group(1)]
        for key, internal in (("internal", True), ("storage", True)):
            st["networks"].setdefault("%s_%s" % (project, key), {"labels": {"com.docker.compose.project": project, "com.docker.compose.network": key}, "internal": internal, "subnets": subnets.get(key, [])})
        for svc, vol in (("postgres", "pgdata"), ("objectstore", "objectdata")):
            st["containers"].append({"id": new_id(svc), "project": project, "service": svc, "state": "created",
                                     "image": "sha256:" + svc, "config_files": cfiles, "env_file": env_file,
                                     "health": "healthy", "mounts": ["%s_%s" % (project, vol)]})
        done()
    if sub == "exec":
        return pg(project, rest)
    if sub == "up":
        for c in mine:
            c["state"] = "running"
        done()
    done()


def pg(project, rest):
    assert rest[0] == "-T" and rest[1] == "postgres", rest
    cmd = rest[2:]
    if cmd[:2] == ["sh", "-c"]:
        assert "$(cat /run/secrets/db_owner_password)" in cmd[2]
        cmd = cmd[4:]
    db = st.setdefault("db", {}).setdefault(project, {"counts": "", "fresh": "0|0|0|0", "clients": "0"})
    prog = cmd[0]
    if prog == "pg_dumpall":
        print("CREATE ROLE flashcards_owner;\nCREATE ROLE backend_app;")
        done()
    if prog == "pg_dump":
        db["dumped"] = True
        if beh.get("counts_change_during_dump"):
            db["counts"] = db["counts"].replace("content.cards|3", "content.cards|4")
        sys.stdout.write("FAKEDUMP\n" + db["counts"])
        done()
    if prog == "pg_restore":
        data = sys.stdin.read()
        if not data.startswith("FAKEDUMP\n"):
            fail("pg_restore: not a dump")
        if "-l" in cmd:
            print("; fake TOC")
            done()
        db["counts"] = data[len("FAKEDUMP\n"):]
        if beh.get("restore_counts_mismatch"):
            db["counts"] = db["counts"].replace("content.cards|3", "content.cards|2")
        db["restored"] = True
        done()
    if prog == "psql":
        sql = cmd[cmd.index("-c") + 1] if "-c" in cmd else None
        if sql is None:
            db["roles_sql"] = sys.stdin.read()
            done()
        if "schema_migrations.latest" in sql:
            sys.stdout.write(db["counts"])
        elif "pg_stat_activity" in sql and "usename" in sql:
            print("backend_app app=fake-writer addr=172.30.0.9")
        elif "pg_stat_activity" in sql:
            print(db.get("clients", "0"))
        elif "server_version" in sql:
            print("18.7")
        elif "pg_namespace" in sql:
            print(db.get("fresh", "0|0|0|0"))
        else:
            fail("unknown sql")
        done()
    fail("unknown exec %r" % cmd)


def run(args):
    args = [a for a in args if a not in ("--rm",)]
    interactive = "-i" in args
    args = [a for a in args if a != "-i"]
    net = take(args, "--network")
    if net != ["none"]:
        fail("docker run without --network none")
    vols = take(args, "-v")
    entry = take(args, "--entrypoint")[0]
    image, cmd = args[0], args[1:]
    assert len(vols) == 1, vols
    vol, _, rest = vols[0].partition(":")
    mount = rest.split(":")
    if mount[0] != "/data":
        fail("unexpected mount %s" % vols[0])
    if vol not in st["volumes"]:
        fail("volume %s does not exist (real docker would create it)" % vol)
    host_dir = os.path.join(SD, "volumes", vol)
    save()
    lock.close()
    cmd = [a.replace("/data", host_dir) for a in cmd]
    if entry == "tar" and "--hard-dereference" in cmd and beh.get("tar_without_hard_dereference"):
        sys.stderr.write("tar: unrecognized option '--hard-dereference'\n")
        sys.exit(64)
    rc = subprocess.call([entry] + cmd, stdin=sys.stdin if interactive else subprocess.DEVNULL)
    if rc == 0 and entry == "tar" and "-xpf" in cmd and beh.get("corrupt_extract"):
        for root, _, names in os.walk(host_dir):
            for n in names:
                with open(os.path.join(root, n), "a") as fh:
                    fh.write("corrupt")
                sys.exit(0)
    sys.exit(rc)


argv = sys.argv[1:]
cmd = argv[0]
if cmd == "compose":
    compose(argv[1:])
elif cmd == "ps":
    ps(argv[1:])
elif cmd == "inspect":
    args = argv[1:]
    fmt = take(args, "-f")[0]
    rc = 0
    for ident in args:
        found = [c for c in st["containers"] if c["id"] == ident]
        if not found:
            sys.stderr.write("Error: No such object: %s\n" % ident)
            rc = 1
            continue
        print(render_container(fmt, found[0]))
    done(rc)
elif cmd == "info":
    print(st.get("daemon_id", "FAKE-DAEMON"))
    done()
elif cmd == "volume":
    args = argv[2:]
    if argv[1] == "ls":
        filters = take(args, "--filter")
        for name, v in sorted(st["volumes"].items()):
            if all(match_label(v.get("labels", {}), f.partition("=")[2]) for f in filters):
                print(name)
        done()
    if argv[1] == "inspect":
        take(args, "-f")
        done(0 if all(a in st["volumes"] for a in args) else 1)
elif cmd == "network":
    args = argv[2:]
    if argv[1] == "ls":
        filters = take(args, "--filter")
        for name, n in sorted(st["networks"].items()):
            if all(match_label(n.get("labels", {}), f.partition("=")[2]) for f in filters):
                print(name)
        done()
    if argv[1] == "inspect":
        fmt = (take(args, "-f") or ["{{.Name}}"])[0]
        rc = 0
        for a in args:
            if a not in st["networks"]:
                rc = 1
                continue
            print(render_network(fmt, a, st["networks"][a]))
        done(rc)
elif cmd == "run":
    run(argv[1:])
fail("unsupported command %r" % argv)
