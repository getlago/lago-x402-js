# Changelog

All notable changes to this project will be documented here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [SemVer](https://semver.org).

## [Unreleased]

### Added

- x402 v2 wire layer (internal, not exported yet): renders Lago gate-check challenges as `PAYMENT-REQUIRED` (with a `sign-in-with-x` challenge bound to the configured origin) and settled purchases as `PAYMENT-RESPONSE`; decodes `PAYMENT-SIGNATURE` and `SIGN-IN-WITH-X` without ever surfacing their contents in errors or logs.
