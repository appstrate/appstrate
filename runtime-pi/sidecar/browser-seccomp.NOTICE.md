# Browser worker seccomp profile

`browser-seccomp.json` is derived from Moby's default seccomp profile at tag
`seccomp/v0.2.1`:

<https://github.com/moby/profiles/blob/seccomp/v0.2.1/seccomp/default.json>

Moby is licensed under Apache-2.0. Appstrate's delta removes the conditional
`clone3 -> ENOSYS` fallback and allows `chroot`, `clone`, `clone3`, `setns`, and
`unshare` without `CAP_SYS_ADMIN`. Those are the syscalls Chromium needs to
establish its own user/PID/network namespace sandbox while the worker
container retains `no-new-privileges`, drops every host capability, and uses a
read-only root filesystem.

Do not replace this profile with `seccomp=unconfined` or launch Chromium with
`--no-sandbox`.
