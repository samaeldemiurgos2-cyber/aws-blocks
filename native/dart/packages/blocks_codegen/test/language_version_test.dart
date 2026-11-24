// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:blocks_codegen/builder.dart';
import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:blocks_codegen/src/language_version.dart';
import 'package:build/build.dart';
import 'package:package_config/package_config.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:test/test.dart';

/// The smallest [BuildStep] the builder uses: one spec input, the package
/// config of the package being built, and the one output it writes.
class _FakeBuildStep implements BuildStep {
  _FakeBuildStep(this.spec, this.languageVersion);

  final String spec;
  final LanguageVersion? languageVersion;
  final outputs = <AssetId, String>{};

  @override
  final AssetId inputId = AssetId('app', 'lib/blocks.spec.json');

  @override
  Future<String> readAsString(AssetId id, {Encoding encoding = utf8}) async {
    expect(id, inputId);
    return spec;
  }

  @override
  Future<PackageConfig> get packageConfig async => PackageConfig([
    Package(
      'app',
      Uri.parse('file:///app/'),
      packageUriRoot: Uri.parse('file:///app/lib/'),
      languageVersion: languageVersion,
    ),
  ]);

  @override
  Future<void> writeAsString(
    AssetId id,
    FutureOr<String> contents, {
    Encoding encoding = utf8,
  }) async {
    outputs[id] = await contents;
  }

  @override
  dynamic noSuchMethod(Invocation invocation) => throw UnimplementedError(
    'blocks_codegen builder called BuildStep.${invocation.memberName}',
  );
}

final _spec = File(
  '../../../codegen-fixtures/01-primitives/spec.json',
).readAsStringSync();

/// What the build_runner builder writes for [_spec] in a package at [version].
Future<String> _build(LanguageVersion? version) async {
  final step = _FakeBuildStep(_spec, version);
  await blocksCodegenBuilder(const BuilderOptions({})).build(step);
  return step.outputs[AssetId('app', 'lib/blocks.blocks.dart')]!;
}

String _generate(Version? version) => DartCodeGenerator(
  languageVersion: version,
).generate(CodegenModelBuilder().build(const OpenRpcParser().parse(_spec)));

void main() {
  group('the build_runner builder', () {
    test('formats for the language version of the package it builds', () async {
      // 3.6 is the last short-style version, so its layout differs from 3.11's.
      final output = await _build(LanguageVersion(3, 6));
      expect(output, _generate(Version(3, 6, 0)));
      expect(output, isNot(_generate(Version(3, 11, 0))));
    });

    test(
      'formats at the default when the package records no version',
      () async {
        expect(await _build(null), _generate(defaultLanguageVersion));
      },
    );

    test('refuses a package older than Dart 3.0', () {
      expect(
        _build(LanguageVersion(2, 19)),
        throwsA(
          isA<ArgumentError>().having(
            (e) => e.message,
            'message',
            contains('older than 3.0'),
          ),
        ),
      );
    });
  });

  group('language version helpers', () {
    test('formatterLanguageVersion keeps major and minor', () {
      expect(formatterLanguageVersion(LanguageVersion(3, 6)), Version(3, 6, 0));
      expect(formatterLanguageVersion(null), isNull);
    });

    test('parseLanguageVersion takes major.minor with an optional patch', () {
      expect(parseLanguageVersion('3.11'), Version(3, 11, 0));
      expect(parseLanguageVersion(' 3.11.0 '), Version(3, 11, 0));
      expect(parseLanguageVersion('3'), isNull);
      expect(parseLanguageVersion('three'), isNull);
    });

    test('unsupportedLanguageVersion rejects only pre-3.0 versions', () {
      expect(unsupportedLanguageVersion(Version(3, 0, 0)), isNull);
      expect(
        unsupportedLanguageVersion(Version(2, 19, 0)),
        'language version 2.19 is older than 3.0, which generated clients need',
      );
    });
  });
}
