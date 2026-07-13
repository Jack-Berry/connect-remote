---
title: Privacy Policy — Connect Remote
permalink: /privacy/
---

# Privacy Policy — Connect Remote

_Last updated: 13 July 2026_

Connect Remote is an open-source companion app for Genesis, Kia, and Hyundai
vehicles, running on Even Realities G2 smart glasses. This policy explains what
data the app handles and who can see it.

## The short version

**The developer of Connect Remote does not collect, store, receive, or have
access to any of your data.** There is no analytics, no tracking, no developer
server, and no account with the developer. Everything the app does happens
either on your own devices or on a backend server that **you** deploy and
control.

## How Connect Remote is structured

Connect Remote has two parts:

1. **The glasses app** — a web app that runs inside the Even Realities phone app
   and displays information on your G2 glasses.
2. **A backend server** — a small service that **you deploy yourself** (for
   example, on Render or your own hardware) using your own vehicle account
   credentials.

The glasses app talks only to the backend **you** set up. The developer operates
no server and is never in the data path.

## What data is involved, and where it lives

- **Your vehicle account credentials** (username, password, PIN) are entered by
  you into **your own backend server's** configuration. They are used solely to
  authenticate with your vehicle manufacturer's connected-services platform
  (Genesis Connected Services, Kia Connect, or Hyundai Bluelink) on your behalf.
  They are never sent to the developer and never stored in the glasses app.

- **An API token** you generate secures communication between your glasses app
  and your backend. It is stored locally in the Even phone app's storage on your
  device, and in your backend's configuration. Only you hold it.

- **Vehicle data** (state of charge, range, lock status, charging state,
  climate state, and — for features you enable — location) is retrieved by your
  backend from your manufacturer's platform and shown on your glasses. It is not
  logged or transmitted anywhere else by the app.

- **Settings** (backend URL, token, climate preferences) are stored locally in
  the Even phone app's storage on your device.

## Network access

The app requests network permission so the glasses app can reach the backend
**you** specify. This permission is used only to communicate with your own
backend server. The app does not contact the developer or any third party you
have not configured.

## Third parties

Because you deploy your own backend, the third parties involved are the ones
**you** choose:

- **Your vehicle manufacturer** (Genesis / Kia / Hyundai and their connected-
  services platform), which your backend authenticates with using your
  credentials. Their handling of your data is governed by their own privacy
  policy.
- **Your hosting provider** (e.g. Render), if you deploy your backend there.
  Their handling of your data is governed by their own privacy policy.

Connect Remote is not affiliated with, endorsed by, or sponsored by Genesis,
Kia, Hyundai, Hyundai Motor Group, or Even Realities.

## Data retention and deletion

The developer holds none of your data, so there is nothing for the developer to
retain or delete. To remove your data:

- Clear the app's settings on your phone to remove the stored backend URL and
  token.
- Delete or reconfigure your backend server to remove your stored credentials.
- Revoke access from within your manufacturer's connected-services account if
  you wish to end that connection.

## Children

Connect Remote is not directed at children and collects no data from anyone.

## Changes to this policy

This policy may be updated as the app evolves. Material changes will be
reflected in this file with a new "last updated" date.

## Contact

Questions about this policy can be directed to the project maintainer via the
project's GitHub repository:
https://github.com/Jack-Berry/connect-remote
