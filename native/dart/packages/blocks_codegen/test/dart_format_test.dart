// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:convert';
import 'dart:io';

import 'package:blocks_codegen/blocks_codegen.dart';
import 'package:pub_semver/pub_semver.dart';
import 'package:test/test.dart';

/// A spec whose names are long enough that every signature, parameter list,
/// constructor, `fromJson`, `toJson` and `toString` has to split.
String _longNamesSpec() {
  const field =
      'aVeryLongFieldNameThatPushesEveryLinePastTheFormatterPageWidth';
  const type = 'AnExtraordinarilyLongModelTypeNameForTheFormatterToSplit';
  return jsonEncode({
    'openrpc': '1.3.2',
    'info': {'title': 'long names', 'version': '1.0.0'},
    'components': {
      'schemas': {
        type: {
          'type': 'object',
          'properties': {
            for (var i = 0; i < 4; i++) '$field$i': {'type': 'string'},
            'tags': {
              'type': 'array',
              'items': {r'$ref': '#/components/schemas/$type'},
            },
            'byName': {
              'type': 'object',
              'additionalProperties': {r'$ref': '#/components/schemas/$type'},
            },
          },
          'required': ['${field}0', '${field}1'],
        },
      },
    },
    'methods': [
      {
        'name': 'aRatherLongNamespaceName.anOperationWithAVeryLongNameToo',
        'params': [
          for (var i = 0; i < 4; i++)
            {
              'name': '$field$i',
              'required': i.isEven,
              'schema': {r'$ref': '#/components/schemas/$type'},
            },
        ],
        'result': {
          'name': 'result',
          'schema': {
            'type': 'array',
            'items': {r'$ref': '#/components/schemas/$type'},
          },
        },
      },
    ],
  });
}

String _generate(String spec, {Version? languageVersion}) => DartCodeGenerator(
  languageVersion: languageVersion,
).generate(CodegenModelBuilder().build(const OpenRpcParser().parse(spec)));

/// The files `dart format` (the SDK's own, not this package's `dart_style`)
/// would change when formatting them at [languageVersion].
List<String> _reformatted(
  Map<String, String> sources, {
  required String languageVersion,
}) {
  final dir = Directory.systemTemp.createTempSync('blocks_codegen_format_');
  addTearDown(() => dir.deleteSync(recursive: true));
  for (final MapEntry(:key, :value) in sources.entries) {
    File('${dir.path}/$key.dart').writeAsStringSync(value);
  }
  final result = Process.runSync(Platform.resolvedExecutable, [
    'format',
    '--output=none',
    '--show=changed',
    '--language-version=$languageVersion',
    // A width other than the default, as a package's analysis_options.yaml
    // may set: the `// dart format width=` comment must override it.
    '--page-width=120',
    dir.path,
  ]);
  expect(
    result.exitCode,
    0,
    reason: 'dart format failed:\n${result.stdout}\n${result.stderr}',
  );
  return RegExp(
    r'^Changed (.+)$',
    multiLine: true,
  ).allMatches(result.stdout as String).map((m) => m[1]!).toList();
}

void main() {
  final fixturesDir = Directory('../../../codegen-fixtures');

  test('every fixture generates a client `dart format` leaves unchanged', () {
    final sources = <String, String>{};
    for (final fixture in fixturesDir.listSync().whereType<Directory>()) {
      final spec = File('${fixture.path}/spec.json');
      if (!spec.existsSync()) continue;
      final name = fixture.uri.pathSegments.where((s) => s.isNotEmpty).last;
      try {
        sources[name] = _generate(spec.readAsStringSync());
      } on FormatException {
        // A spec the generator refuses has no client (see golden_file_test).
      }
    }
    expect(sources, isNotEmpty);
    expect(
      _reformatted(
        sources,
        languageVersion: _majorMinor(defaultLanguageVersion),
      ),
      isEmpty,
    );
  });

  test(
    'a client whose lines all overflow is left unchanged by `dart format`',
    () {
      final output = _generate(_longNamesSpec());
      // The spec forces splits, so this checks wrapped code, not short lines.
      // (A single name longer than the page still overflows, as `dart format`
      // leaves it.)
      expect(output, contains('anOperationWithAVeryLongNameToo({\n'));
      expect(_reformatted({'long': output}, languageVersion: '3.11'), isEmpty);
    },
  );

  test('output pins its page width before any code', () {
    final output = _generate(_longNamesSpec());
    final firstCode = output
        .split('\n')
        .indexWhere((l) => l.isNotEmpty && !l.startsWith('//'));
    final widthComment = output
        .split('\n')
        .indexOf('// dart format width=$generatedPageWidth');
    expect(widthComment, isNot(-1));
    expect(widthComment, lessThan(firstCode));
  });

  test('output is formatted for the language version it is given', () {
    final spec = _longNamesSpec();
    // The SDK's own language version: `dart format` styles some constructs
    // by version (3.7, 3.10 and 3.13 so far).
    final sdk = Version.parse(Platform.version.split(' ').first);
    final current = Version(sdk.major, sdk.minor, 0);
    expect(
      _reformatted({
        'current': _generate(spec, languageVersion: current),
      }, languageVersion: _majorMinor(current)),
      isEmpty,
    );
    // Without one, it is formatted for the oldest a consumer can have.
    expect(
      _generate(spec),
      _generate(spec, languageVersion: defaultLanguageVersion),
    );
  });

  test(
    'defaultLanguageVersion is the lower bound of blocks_runtime\'s SDK',
    () {
      final pubspec = File('../blocks_runtime/pubspec.yaml').readAsStringSync();
      final sdk = RegExp(
        r'^\s+sdk: \^(\d+\.\d+)\.\d+',
        multiLine: true,
      ).firstMatch(pubspec)![1]!;
      expect(_majorMinor(defaultLanguageVersion), sdk);
    },
  );
}

/// [version] as `dart format --language-version` takes it.
String _majorMinor(Version version) => '${version.major}.${version.minor}';
