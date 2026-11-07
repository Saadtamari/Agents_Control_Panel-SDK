# Security policy

This SDK runs inside production applications, so we treat vulnerabilities in it as urgent.

## Reporting a vulnerability

Please **do not open a public issue**. Report privately through either:

- GitHub: **Security → Report a vulnerability** on this repository (private advisory), or
- Email: founders@agentcontrolpanel.si

Include the affected version, a description, and steps to reproduce. We acknowledge reports within 3 business
days and keep you updated until a fix ships. Our responsible disclosure policy, including safe harbor, is at
https://agentcontrolpanel.si/legal/responsible-disclosure.

## Supported versions

The latest minor release receives security fixes. Upgrade with `npm install agent-control-panel@latest`.

## How releases are protected

Releases are built by a GitHub Actions workflow and **staged** on npm; a maintainer approves each version on
npmjs.com with two-factor authentication before it becomes installable. There are no long-lived npm tokens.
