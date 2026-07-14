#!/usr/bin/env bash
# One-time setup for the proxy VPS (DigitalOcean, Ubuntu 24.04,
# 178.128.168.63 / car-proxy.berrydev.co.uk).
#
# RUN THIS MANUALLY, SECTION BY SECTION, over SSH as root — read each section
# before running it. It is written to be safe to re-run, but it is a runbook
# first and a script second.
#
# ORDER MATTERS. Two sections change what can log in:
#   - Section 4 creates the `deploy` user and installs your SSH key.
#   - Section 6 disables root SSH login and password auth. Run it LAST, and
#     ONLY after Section 5's check (a fresh `ssh deploy@…` from your laptop)
#     has succeeded — otherwise you lock yourself out of the box.
#
# Before starting: create the DNS A record
#     car-proxy.berrydev.co.uk -> 178.128.168.63
# It must resolve before the first `docker compose up`, or Caddy cannot pass
# the Let's Encrypt challenge.

set -euo pipefail

# --- Adjust these ----------------------------------------------------------
DEPLOY_USER="deploy"
# Public key that will be allowed to log in as ${DEPLOY_USER}. Root's key is
# already on the box (DigitalOcean installs it at provisioning).
PUBKEY_SOURCE="/root/.ssh/authorized_keys"
# ---------------------------------------------------------------------------


echo "### 1. Firewall — allow SSH/HTTP/HTTPS, deny everything else inbound"
# 22 stays open throughout; 80/443 are for Caddy (80 also serves the ACME
# challenge). This section is safe: it explicitly allows SSH before enabling.
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable
ufw status verbose


echo "### 2. Unattended security upgrades"
apt-get update
apt-get install -y unattended-upgrades
dpkg-reconfigure -f noninteractive unattended-upgrades
# Kernel/libc updates only apply on reboot; check `cat /var/run/reboot-required`
# occasionally, or enable Unattended-Upgrade::Automatic-Reboot in
# /etc/apt/apt.conf.d/50unattended-upgrades if brief downtime is acceptable.


echo "### 3. Docker Engine + compose plugin (official Docker apt repo)"
apt-get install -y ca-certificates curl
install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
chmod a+r /etc/apt/keyrings/docker.asc
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
  https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  > /etc/apt/sources.list.d/docker.list
apt-get update
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
docker --version && docker compose version


echo "### 4. Non-root deploy user (SSH key only, docker group)"
# Membership of the docker group is root-equivalent on this box — acceptable
# here because the deploy user's whole job is running docker compose.
if ! id -u "${DEPLOY_USER}" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
fi
usermod -aG docker "${DEPLOY_USER}"
install -d -m 700 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "/home/${DEPLOY_USER}/.ssh"
install -m 600 -o "${DEPLOY_USER}" -g "${DEPLOY_USER}" "${PUBKEY_SOURCE}" "/home/${DEPLOY_USER}/.ssh/authorized_keys"
echo "deploy user ready: ${DEPLOY_USER}"


echo "### 5. STOP — verify deploy-user access from your OWN machine"
cat <<'EOF'
  In a NEW terminal on your laptop (keep this root session open!):

      ssh deploy@car-proxy.berrydev.co.uk
      docker ps          # should work without sudo (docker group)

  Do not continue to section 6 until that login works.
EOF


# ---------------------------------------------------------------------------
# ### 6. LOCKDOWN — run LAST, only after Section 5 succeeded.
#
# This block is commented out so a top-to-bottom run of the script cannot
# lock you out. Uncomment (or paste line by line) once the deploy login is
# confirmed. It disables BOTH root SSH login and all password auth; from then
# on the only way in is the deploy user's SSH key.
#
# cat > /etc/ssh/sshd_config.d/99-hardening.conf <<'CONF'
# PermitRootLogin no
# PasswordAuthentication no
# KbdInteractiveAuthentication no
# CONF
# sshd -t                       # syntax check BEFORE reloading
# systemctl reload ssh
# # Keep this root session open and confirm once more from your laptop:
# #   ssh deploy@car-proxy.berrydev.co.uk   -> must work
# #   ssh root@car-proxy.berrydev.co.uk    -> must now be refused
# ---------------------------------------------------------------------------

echo "Base setup done. See deploy/README.md for the first deploy."
