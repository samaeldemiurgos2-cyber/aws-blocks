// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'dart:io';

import 'package:args/args.dart';
import 'package:blocks_codegen/src/parser.dart';
import 'package:blocks_codegen/src/builder.dart';
import 'package:blocks_codegen/src/generator.dart';
import 'package:blocks_codegen/src/language_version.dart';
import 'package:package_config/package_config.dart';
import 'package:pub_semver/pub_semver.dart';

Future<void> main(List<String> args) async {
  final parser = ArgParser()
    ..addOption('spec', abbr: 's', help: 'Path to the OpenRPC spec file')
    ..addOption(
      'output',
      abbr: 'o',
      help: 'Output path for the generated Dart file (stdout if omitted)',
    )
    ..addFlag(
      'fail-on-collision',
      negatable: false,
      help:
          'Treat inline-type name collisions that survive qualification as a '
          'hard error. By default they are auto-disambiguated with a '
          'deterministic suffix and reported as a warning.',
    )
    ..addMultiOption(
      'native-package-opt-out',
      help:
          'Logical native package identity whose transferable bindings are '
          'not applied, so its direct results stay UnknownTransferable. An '
          'identity the spec does not declare opts nothing out and is '
          'reported as AWSBLOCKS-NATIVE-006. Repeatable.',
    )
    ..addOption(
      'language-version',
      help:
          'Dart language version (for example 3.11) to format the output '
          'for. Defaults to the language version of the package the output '
          'is written into (the current directory when writing to stdout), '
          'or ${majorMinor(defaultLanguageVersion)} when that package cannot '
          'be found.',
    )
    ..addFlag('help', abbr: 'h', negatable: false, help: 'Show usage');

  final ArgResults results;
  try {
    results = parser.parse(args);
  } on FormatException catch (e) {
    stderr.writeln('Error: ${e.message}');
    stderr.writeln();
    stderr.writeln(
      'Usage: dart run blocks_codegen --spec <path> [--output <path>]',
    );
    stderr.writeln(parser.usage);
    exit(1);
  }

  if (results['help'] as bool) {
    stdout.writeln(
      'Usage: dart run blocks_codegen --spec <path> [--output <path>]',
    );
    stdout.writeln();
    stdout.writeln(parser.usage);
    exit(0);
  }

  final specPath = results['spec'] as String?;
  if (specPath == null) {
    stderr.writeln('Error: --spec is required');
    stderr.writeln();
    stderr.writeln(
      'Usage: dart run blocks_codegen --spec <path> [--output <path>]',
    );
    stderr.writeln(parser.usage);
    exit(1);
  }
  final outputPath = results['output'] as String?;

  final specFile = File(specPath);
  if (!specFile.existsSync()) {
    stderr.writeln('Error: spec file not found: $specPath');
    exit(1);
  }

  final contents = specFile.readAsStringSync();
  final failOnCollision = results['fail-on-collision'] as bool;
  final optedOutPackages = (results['native-package-opt-out'] as List<String>)
      .map((s) => s.trim())
      .toSet();
  if (optedOutPackages.remove('')) {
    stderr.writeln(
      'Error: --native-package-opt-out requires a package identity',
    );
    exit(1);
  }
  final Version? languageVersion;
  final languageVersionArg = results['language-version'] as String?;
  if (languageVersionArg != null) {
    languageVersion = parseLanguageVersion(languageVersionArg);
    if (languageVersion == null) {
      stderr.writeln(
        'Error: --language-version must be <major>.<minor>, '
        'got "$languageVersionArg"',
      );
      exit(1);
    }
  } else {
    languageVersion = await _packageLanguageVersion(
      File(outputPath ?? 'stdout.dart').absolute,
    );
  }
  // A pre-3.0 package can't compile the client, and the formatter can't
  // parse it there: say so instead of reporting a generator bug.
  final tooOld = languageVersion == null
      ? null
      : unsupportedLanguageVersion(languageVersion);
  if (tooOld != null) {
    stderr.writeln('Error: $tooOld');
    exit(1);
  }

  final String output;
  try {
    final rpcModel = const OpenRpcParser().parse(contents);
    final codegenModel = CodegenModelBuilder(
      failOnCollision: failOnCollision,
      optedOutPackages: optedOutPackages,
    ).build(rpcModel);
    for (final w in codegenModel.warnings) {
      stderr.writeln('Warning: $w');
    }
    output = DartCodeGenerator(
      languageVersion: languageVersion,
    ).generate(codegenModel);
  } on FormatException catch (e) {
    stderr.writeln('Error: ${e.message}');
    exit(1);
  } on NamingConflictException catch (e) {
    stderr.writeln('Error: ${e.message}');
    exit(1);
  } on StateError catch (e) {
    // A generator bug, such as output that doesn't parse.
    stderr.writeln('Error: ${e.message}');
    exit(1);
  }

  if (outputPath != null) {
    final outFile = File(outputPath);
    outFile.parent.createSync(recursive: true);
    outFile.writeAsStringSync(output);
    stdout.writeln('Generated: $outputPath');
  } else {
    stdout.write(output);
  }
}

/// The language version of the package containing [file], read from the
/// nearest `.dart_tool/package_config.json` as `dart format` reads it, or
/// null when [file] is in no resolved package.
Future<Version?> _packageLanguageVersion(File file) async {
  // The output directory may not exist yet; search from its nearest ancestor.
  var dir = file.parent;
  while (!dir.existsSync() && dir.parent.path != dir.path) {
    dir = dir.parent;
  }
  try {
    final config = await findPackageConfig(dir);
    return formatterLanguageVersion(
      config?.packageOf(file.uri)?.languageVersion,
    );
  } on Exception {
    // An unreadable package config only loses the detected version; the
    // output is still formatted, at the default language version.
    return null;
  }
}
