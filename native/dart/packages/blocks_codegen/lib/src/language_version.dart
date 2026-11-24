// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:package_config/package_config.dart';
import 'package:pub_semver/pub_semver.dart';

/// The oldest Dart language version generated clients compile at: they use
/// sealed classes, records and patterns, which Dart 3.0 introduced.
final minimumLanguageVersion = Version(3, 0, 0);

/// [version] as the formatter takes it (`3.11.0`), or null when the package
/// config records none.
///
/// The CLI reads [version] from the package config of the package it writes
/// into, and the build_runner builder from the package it builds.
Version? formatterLanguageVersion(LanguageVersion? version) =>
    version == null ? null : Version(version.major, version.minor, 0);

/// Parses a `<major>.<minor>` language version, with an optional `.patch`
/// that is ignored, as `--language-version` takes it, or returns null.
Version? parseLanguageVersion(String value) {
  final match = RegExp(r'^(\d+)\.(\d+)(?:\.\d+)?$').firstMatch(value.trim());
  if (match == null) return null;
  return Version(int.parse(match[1]!), int.parse(match[2]!), 0);
}

/// `<major>.<minor>` of [version], as `dart format --language-version` and
/// `--language-version` take it.
String majorMinor(Version version) => '${version.major}.${version.minor}';

/// Why a client can't be generated for a package at [version], or null when
/// it can.
String? unsupportedLanguageVersion(Version version) =>
    version < minimumLanguageVersion
    ? 'language version ${majorMinor(version)} is older than '
          '${majorMinor(minimumLanguageVersion)}, which generated clients need'
    : null;
