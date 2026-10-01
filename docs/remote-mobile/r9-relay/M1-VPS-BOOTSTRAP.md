# R9-RELAY-03 GATE 2B-M1 — VPS Bootstrap Commands (no SSH, nothing transferred)

**Purpose:** prepare the VPS-side verification capability **before** a real presigned URL exists, so M1
does not depend on any script already being on the VPS.

**These commands are TYPE-able, not paste-dependent.** That is deliberate: the Gate 2B failure was a
multi-line paste that collapsed to one line, so the bootstrap must not itself rely on pasting a block.
Each command is a single short line. No secrets, no parameters, nothing to corrupt.

Run them in the **Recovery Console** (or any VPS shell). They create **no secrets**, **write nothing
outside `~/m1`**, and **do not contact R2** except in step B4.

**None of these commands calls `exit`.** An `exit` in a Recovery Console shell would close your session;
every check here reports and continues instead.

---

## Step B0 — confirm the required tools exist

```sh
command -v bash curl sha256sum tr
```

Expected: four paths. Anything missing **stops M1** — report it rather than working around it.
Ubuntu 24.04 has all four in the base image.

## Step B1 — create the working directory

```sh
umask 077; mkdir -p ~/m1; cd ~/m1; pwd
```

Expected: `/root/m1` (or your home). `umask 077` makes everything created here owner-only.

## Step B2 — confirm the directory is owner-only

```sh
stat -c '%a %U' ~/m1
```

Expected: `700 root`. If the mode is not `700`, **stop**.

---

## Step B3 — screen and measure the pasted URL

Type these after pasting the URL into `~/m1/url.txt`. **Do not paste this file's contents as a block** —
the whole point is that typed single lines cannot collapse the way a block can.

### B3a — screen for characters that would invalidate the signature

```sh
cd ~/m1; F=url.txt; echo "bytes=$(wc -c <$F) cr=$(tr -cd '\r' <$F | wc -c) sp=$(tr -cd ' ' <$F | wc -c) tab=$(tr -cd '\t' <$F | wc -c)"
```

Expected: `bytes=<N> cr=0 sp=0 tab=0`.

* **`cr` must be 0.** Anything else means the paste inserted carriage returns.
* **`sp` must be 0.** A presigned URL contains no spaces.
* **`tab` must be 0.**
* **`bytes` must be either `N` or `N+1`**, where `N` is the PC tool's reported URL byte length.
  `N+1` means `vi` appended one trailing newline, which is **tolerated** — see B3b.

If `cr`, `sp` or `tab` is non-zero: **M1 FAIL — stop.** Do not retry with the real URL.

> **On counting lines.** `grep -c ''` counts lines, and its result is easy to misread, so this procedure
> does **not** use it. A single URL line with **no** trailing newline reports `1`; the same line **with**
> one trailing newline reports `2`. **A result of `2` therefore means one extra newline is present — it
> is not itself an error, but it is the reason B3b strips exactly one LF.** Anything that would produce
> `3` or more (an interior newline, or a paste that wrapped) is a failure, and the byte count in B3a
> catches it: the total must be `N` or `N+1`, nothing else.

### B3b — strip at most one trailing LF, then measure the normalised bytes

```sh
cd ~/m1; if [ "$(tail -c 1 url.txt | od -An -tx1 | tr -d ' \n')" = "0a" ]; then head -c $(( $(wc -c < url.txt) - 1 )) url.txt > norm.txt; else cp url.txt norm.txt; fi; echo "bytes=$(wc -c < norm.txt)"; sha256sum norm.txt | cut -d' ' -f1
```

This prints exactly two things:

```text
bytes=<N>
<64 hex characters>
```

Compare them against the **URL byte length** and **URL SHA-256** printed by the PC tool.

* **Both must match exactly.** Any difference: **M1 FAIL — stop.**
* Only **one** trailing LF is stripped. Two are not.

### B3c — confirm the URL is well-formed, without printing it

```sh
cd ~/m1; head -c 8 norm.txt; echo; grep -c 'X-Amz-Signature=' norm.txt; grep -c 'r2.cloudflarestorage.com' norm.txt
```

Expected: `https://`, then `1`, then `1`.

---

## Step B4 — the R2 acceptance probe

Only run this **after B3b matched**. A **404 with `NoSuchKey` is the SUCCESS signal** — the probe object
deliberately does not exist.

### B4a — issue the request WITHOUT putting the URL in your command or history

**Do not write `curl "$(cat norm.txt)"`.** That places the full presigned URL into the shell's command
text, its history file, and the process argument list visible to `ps` — even though it is never echoed.

Instead, pass the URL to `curl` through a file descriptor and read it from the file, so the command text
contains only a filename:

```sh
cd ~/m1; curl -sS --max-redirs 0 --config /dev/fd/3 -o body.txt -w 'HTTP %{http_code}\n' 3<<<"url = \"$(cat norm.txt)\""
```

* `--config /dev/fd/3` makes `curl` read its arguments from a here-string instead of argv, so **the URL
  never appears in the command text or in `ps` output**.
* `--max-redirs 0` **forbids redirects**.
* **No `-k`** — TLS certificate verification stays ON. Do not add `-k`.

> If `/dev/fd/3` is unavailable in your shell, redirect `curl`'s config from a file instead:
>
> ```sh
> cd ~/m1; printf 'url = "%s"\n' "$(cat norm.txt)" > curlrc; chmod 600 curlrc; curl -sS --max-redirs 0 --config curlrc -o body.txt -w 'HTTP %{http_code}\n'; shred -u curlrc 2>/dev/null || rm -f curlrc
> ```
>
> `curlrc` is the second short-lived local copy of the URL. It is created `0600` and removed
> immediately. Note that `cat norm.txt` still puts the URL in the process argument list of `cat`
> briefly; the `--config` route avoids it reaching `curl`'s argv, which is the larger exposure.

### B4b — require the R2 error code

```sh
cd ~/m1; grep -o '<Code>[^<]*</Code>' body.txt
```

Expected: `<Code>NoSuchKey</Code>`.

| Result | Meaning | Action |
| --- | --- | --- |
| `HTTP 404` **and** `NoSuchKey` | the URL is **valid and correctly signed** | **M1 PASS** |
| `HTTP 404`, any other code | inconclusive — a wrong host also 404s | **M1 FAIL — stop** |
| `HTTP 403` | signature rejected: clock skew, wrong key, or corruption | **M1 FAIL — stop** |
| `HTTP 200` | an object exists at the probe key | **STOP and investigate** |

**Both conditions are required.** A bare 404 is not a pass.

The same contract, if you have transferred the verifier and independently verified the transfer:

```sh
bash r9-relay-03-m1-verify-url.sh <expected-bytes> <expected-sha256> --probe
```

## Step B5 — cleanup

```sh
cd ~; rm -f m1/url.txt m1/norm.txt m1/body.txt m1/curlrc; rmdir m1
```

---

## What reaches disk, and where

The PC and the VPS behave **differently**, and it is worth being precise:

| Location | Written to disk | Notes |
| --- | --- | --- |
| **PC** | **non-secret metadata only** (`%TEMP%\r9-m1-metadata\`) | URL byte length, line count, URL SHA-256, timestamps. **No URL and no credential** are ever written. |
| **VPS** | **the presigned URL itself**, briefly | `~/m1/url.txt`, `norm.txt`, and `body.txt` (the R2 response) — the URL must exist as a file for the typed commands to measure and hash it. Created under `umask 077` in a `700` directory, and removed in B5. |

**On deletion:** `shred` (or `rm`) **cannot be guaranteed to erase data from the physical medium**. On
journaled, copy-on-write or SSD-backed storage with wear levelling, previous contents may persist in
blocks that are no longer addressable. The cleanup in B5 is **best-effort hygiene**, not a guarantee of
physical erasure. The URL is short-lived (15 minutes) and scoped to one object, and it expires on its
own — that expiry, not the deletion, is the real containment.

---

## Why this solves the ordering problem

```text
1. B0-B2  prepare and validate the VPS directory      <- BEFORE any URL exists
2. B3     the screening and measuring logic is TYPED  <- no dependency on transferring a script
3. B4     the R2 probe is TYPED, URL kept out of argv <- no dependency either
4. only then generate a real presigned URL on the PC
```

The PC-side script is never assumed to be on the VPS. Nothing is transferred. The commands that carry
the logic are short, single-line, secret-free and `exit`-free, so they cannot fail in the way the
Gate 2B paste failed, and cannot close your console session.

**If you prefer the script**, it must be transferred by a method you have independently verified, and
the transfer itself becomes a prerequisite to measure — not an assumption.
