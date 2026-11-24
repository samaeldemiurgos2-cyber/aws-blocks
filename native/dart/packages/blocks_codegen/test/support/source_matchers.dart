// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import 'package:test/test.dart';

/// Matches generated source that contains [snippet], ignoring layout.
///
/// The generator's output goes through `dart format`'s formatter, so where a
/// line splits, how far it is indented and whether a list ends in a trailing
/// comma depend on the length of the names around it. Both sides are reduced
/// to their tokens before comparing, so a test states the code it expects and
/// the golden files pin the exact layout.
///
/// A snippet ending in `,` (one item of a list) also matches that item last in
/// an unsplit list, where the formatter drops the comma. A whitespace-only
/// snippet, and anything matched against a non-[String], is matched with
/// [contains] as is.
Matcher containsSource(Object? snippet) =>
    snippet is String && snippet.trim().isNotEmpty
    ? _ContainsSource(snippet)
    : contains(snippet);

/// Collapses whitespace, drops it next to punctuation, and drops a trailing
/// comma before a closing bracket: the parts of layout the formatter owns.
String normalizeSource(String source) => source
    .replaceAll(RegExp(r'\s+'), ' ')
    .replaceAllMapped(RegExp(r' ?([^\w\s$]) ?'), (m) => m[1]!)
    .replaceAllMapped(RegExp(r',([)\]}])'), (m) => m[1]!)
    .trim();

class _ContainsSource extends Matcher {
  final String _snippet;
  final RegExp _pattern;

  _ContainsSource(this._snippet) : _pattern = _patternFor(_snippet);

  static RegExp _patternFor(String snippet) {
    final normalized = normalizeSource(snippet);
    if (!normalized.endsWith(',')) return RegExp(RegExp.escape(normalized));
    // `x,` is also `x` closing its list.
    final item = normalized.substring(0, normalized.length - 1);
    return RegExp('${RegExp.escape(item)}(?:,|(?=[)\\]};]))');
  }

  @override
  bool matches(Object? item, Map<dynamic, dynamic> matchState) => item is String
      ? _pattern.hasMatch(normalizeSource(item))
      : contains(_snippet).matches(item, matchState);

  @override
  Description describe(Description description) => description
      .add('contains source ')
      .addDescriptionOf(_snippet)
      .add(' (layout ignored)');
}
