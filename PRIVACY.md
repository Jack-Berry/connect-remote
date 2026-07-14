---
title: Privacy Policy — Connect Remote
permalink: /privacy/
---

# Privacy Policy — Connect Remote

_Last updated: 14 July 2026_

Connect Remote is an open-source companion app for Genesis, Kia, and Hyundai
vehicles, running on Even Realities G2 smart glasses. This policy explains what
data the app handles, where it goes, and what is (and is not) kept.

## The short version

Your vehicle account credentials are stored **only on your phone**. When you
use the app, they are sent — encrypted with HTTPS — to a small relay server
operated by the developer, which uses them to talk to your vehicle
manufacturer's platform and immediately returns the result. **The relay stores
nothing**: no database, no accounts, no analytics, no access logs. Credentials
and vehicle data are never written to disk on the relay and never appear in
its logs.

## How Connect Remote is structured

1. **The glasses app** — a web app that runs inside the Even Realities phone
   app and displays information on your G2 glasses.
2. **The relay server** (`car-proxy.berrydev.co.uk`) — a stateless service
   operated by the developer that forwards your requests to your vehicle
   manufacturer's connected-services platform (Genesis Connected Services,
   Kia Connect, or Hyundai Bluelink). It exists because Even Hub store apps
   must declare a fixed list of network hosts, which rules out user-deployed
   servers.

The relay's source code is in this repository — what it does is auditable.

## What data is involved, and where it lives

- **Your vehicle account credentials** (username, password, PIN, account
  region) are entered by you in the app's settings screen and stored locally
  in the Even phone app's storage on your device. Each request to the relay
  carries them over HTTPS; the relay uses them to authenticate with your
  manufacturer's platform on your behalf and does not persist them. To avoid
  a fresh sign-in on every request, the relay keeps a signed-in session in
  memory for up to 10 minutes of inactivity, keyed by a one-way hash of the
  credentials — the credentials themselves are not retained, and a server
  restart erases all sessions.

- **Vehicle data** (state of charge, range, lock status, charging state,
  climate state) passes through the relay to your glasses and is not stored
  beyond the same short-lived in-memory session.

- **Settings** (credentials, climate preferences, charge limits) are stored
  locally in the Even phone app's storage on your device — nowhere else.

- **Relay logs** contain only the request method, path, status code and
  latency — never request contents, headers, credentials, or vehicle data.
  The web server in front of the relay has access logging disabled. Client IP
  addresses are used transiently in memory for rate limiting and are not
  retained.

## Network access

The app requests network permission for exactly one host — the relay at
`car-proxy.berrydev.co.uk`. The app contacts no other server and no third
party.

## Third parties

- **Your vehicle manufacturer** (Genesis / Kia / Hyundai and their
  connected-services platform), which the relay authenticates with using your
  credentials. Their handling of your data is governed by their own privacy
  policy.
- **DigitalOcean**, which hosts the relay server. It has no access to request
  contents (TLS terminates inside the server), and the relay writes no data
  for it to hold.

Connect Remote is not affiliated with, endorsed by, or sponsored by Genesis,
Kia, Hyundai, Hyundai Motor Group, or Even Realities.

## Data retention and deletion

The relay retains nothing at rest, so there is nothing for the developer to
delete. To remove your data:

- Clear the app's settings (or delete the app) on your phone to remove the
  stored credentials.
- Any in-memory relay session for your account expires by itself within
  10 minutes.
- Change your manufacturer-account password to invalidate anything derived
  from the old credentials.

## Children

Connect Remote is not directed at children and collects no data from anyone.

## Changes to this policy

This policy may be updated as the app evolves. Material changes will be
reflected in this file with a new "last updated" date.

## Contact

Questions about this policy can be directed to the project maintainer via the
project's GitHub repository:
https://github.com/Jack-Berry/connect-remote
