# Ledger device setup

Two Ledger primitives are load-bearing in this project, so a reviewer
reproducing it needs a working device connection:

1. **Device Management Kit (DMK)** — on-device confirmation for a medium-risk
   verdict, so a human approves *what* is being signed rather than merely
   attesting *who* the agent is.
2. **Key Ring** — holding the Subgraph Studio key instead of a `.env` file.

## 1. Device visibility

The device must enumerate on the USB bus. In a VM this requires USB
passthrough to be enabled on the host first.

```bash
lsusb -d 2c97:
# Bus 002 Device 002: ID 2c97:4011 Ledger Nano X
```

If nothing prints, the device is not reaching the guest and no amount of
software configuration will help.

## 2. udev rules

A freshly attached Ledger appears as `/dev/hidraw*` owned by `root:root` at
mode `0600`, so an unprivileged process cannot open it. Install the rules:

```bash
sudo install -m 644 docs/setup/20-ledger.rules /etc/udev/rules.d/20-ledger.rules
sudo udevadm control --reload-rules
sudo udevadm trigger
```

Then **unplug and replug the device** — `udevadm trigger` re-runs rules against
existing devices, but replugging is the reliable way to get a node created
with the new ownership.

Your user must be in `plugdev`:

```bash
id -nG | tr ' ' '\n' | grep -qx plugdev && echo ok || sudo usermod -aG plugdev "$USER"
```

Adding a group takes effect on the next login.

### Verify

```bash
ls -l /dev/hidraw*        # expect: crw-rw---- root plugdev
```

The rules are adapted from [LedgerHQ/udev-rules](https://github.com/LedgerHQ/udev-rules)
with the hidraw node at `0660 root:plugdev` instead of `0666`. The upstream
`0666` lets any local user talk to the device; on a shared machine that is a
wider grant than this project needs. `TAG+="uaccess"` is kept for the libusb
path, but note it grants only to the holder of an active local seat and does
nothing over SSH or in a seatless VM — which is exactly why the explicit group
on the hidraw node is the part that matters here.

## 3. On-device prerequisites

- Device unlocked with its PIN.
- The relevant app open on the device when the SDK expects it.
- Firmware current enough for the DMK version pinned in this repo.

## Security note

Nothing in this project ever asks the device for a private key, and no seed or
recovery phrase is entered anywhere on this machine. The device is used only to
confirm what a transaction does, and to seal a service credential. A prompt
asking you to type a recovery phrase into a computer is always an attack,
including if it appears to come from this project.
