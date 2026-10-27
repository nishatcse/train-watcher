import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../core/api_client.dart';

/// Human wording for any failure, with the reason the owner can act on.
String friendlyError(Object e) {
  if (e is ApiException) return e.message;
  return 'Something went wrong. Please try again.';
}

class ErrorPanel extends StatelessWidget {
  const ErrorPanel({super.key, required this.error, this.onRetry});
  final Object error;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) {
    final offline = error is ApiException && (error as ApiException).isOffline;
    return Center(
      child: Padding(
        padding: const EdgeInsets.all(24),
        child: Column(mainAxisSize: MainAxisSize.min, children: [
          Icon(offline ? Icons.cloud_off : Icons.error_outline, size: 48, color: Theme.of(context).colorScheme.error),
          const SizedBox(height: 12),
          Text(friendlyError(error), textAlign: TextAlign.center),
          if (onRetry != null) ...[
            const SizedBox(height: 16),
            FilledButton.tonalIcon(onPressed: onRetry, icon: const Icon(Icons.refresh), label: const Text('Try again')),
          ],
        ]),
      ),
    );
  }
}

/// Loading / error / data in one place. Background refreshes keep showing the old
/// data instead of flashing a spinner.
class AsyncView<T> extends StatelessWidget {
  const AsyncView({super.key, required this.value, required this.data, this.onRetry});
  final AsyncValue<T> value;
  final Widget Function(T) data;
  final VoidCallback? onRetry;

  @override
  Widget build(BuildContext context) => value.when(
        skipLoadingOnReload: true,
        skipLoadingOnRefresh: true,
        data: data,
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (e, _) => ErrorPanel(error: e, onRetry: onRetry),
      );
}

class SectionTitle extends StatelessWidget {
  const SectionTitle(this.text, {super.key});
  final String text;
  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.fromLTRB(16, 20, 16, 8),
        child: Text(text, style: Theme.of(context).textTheme.titleSmall?.copyWith(color: Theme.of(context).colorScheme.primary, fontWeight: FontWeight.w700)),
      );
}

class StatusChip extends StatelessWidget {
  const StatusChip(this.label, {super.key, this.color, this.icon});
  final String label;
  final Color? color;
  final IconData? icon;
  @override
  Widget build(BuildContext context) {
    final c = color ?? Theme.of(context).colorScheme.primary;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
      decoration: BoxDecoration(color: c.withValues(alpha: 0.12), borderRadius: BorderRadius.circular(20)),
      child: Row(mainAxisSize: MainAxisSize.min, children: [
        if (icon != null) ...[Icon(icon, size: 14, color: c), const SizedBox(width: 4)],
        Text(label, style: TextStyle(color: c, fontSize: 12, fontWeight: FontWeight.w600)),
      ]),
    );
  }
}

void snack(BuildContext context, String message, {bool error = false}) {
  ScaffoldMessenger.of(context)
    ..hideCurrentSnackBar()
    ..showSnackBar(SnackBar(
      content: Text(message),
      backgroundColor: error ? Theme.of(context).colorScheme.error : null,
      behavior: SnackBarBehavior.floating,
    ));
}

Future<bool> confirm(BuildContext context, {required String title, required String message, String action = 'Confirm'}) async {
  final r = await showDialog<bool>(
    context: context,
    builder: (c) => AlertDialog(
      title: Text(title),
      content: Text(message),
      actions: [
        TextButton(onPressed: () => Navigator.pop(c, false), child: const Text('Cancel')),
        FilledButton(onPressed: () => Navigator.pop(c, true), child: Text(action)),
      ],
    ),
  );
  return r ?? false;
}

/// Searchable list in a bottom sheet — used for stations, trains and classes.
Future<T?> showSearchPicker<T>(
  BuildContext context, {
  required String title,
  required List<T> items,
  required String Function(T) label,
  String Function(T)? subtitle,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    useSafeArea: true,
    builder: (c) => _PickerSheet<T>(title: title, items: items, label: label, subtitle: subtitle),
  );
}

class _PickerSheet<T> extends StatefulWidget {
  const _PickerSheet({required this.title, required this.items, required this.label, this.subtitle});
  final String title;
  final List<T> items;
  final String Function(T) label;
  final String Function(T)? subtitle;
  @override
  State<_PickerSheet<T>> createState() => _PickerSheetState<T>();
}

class _PickerSheetState<T> extends State<_PickerSheet<T>> {
  String q = '';
  @override
  Widget build(BuildContext context) {
    final shown = widget.items.where((e) => widget.label(e).toLowerCase().contains(q.toLowerCase())).toList();
    return Padding(
      padding: EdgeInsets.only(bottom: MediaQuery.of(context).viewInsets.bottom),
      child: SizedBox(
        height: MediaQuery.of(context).size.height * 0.85,
        child: Column(children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(16, 16, 16, 8),
            child: Row(children: [
              Expanded(child: Text(widget.title, style: Theme.of(context).textTheme.titleLarge)),
              IconButton(onPressed: () => Navigator.pop(context), icon: const Icon(Icons.close)),
            ]),
          ),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 16),
            child: TextField(
              autofocus: true,
              decoration: const InputDecoration(prefixIcon: Icon(Icons.search), hintText: 'Search', border: OutlineInputBorder()),
              onChanged: (v) => setState(() => q = v),
            ),
          ),
          const SizedBox(height: 8),
          Expanded(
            child: shown.isEmpty
                ? const Center(child: Text('Nothing matches'))
                : ListView.builder(
                    itemCount: shown.length,
                    itemBuilder: (c, i) => ListTile(
                      title: Text(widget.label(shown[i])),
                      subtitle: widget.subtitle == null ? null : Text(widget.subtitle!(shown[i])),
                      onTap: () => Navigator.pop(context, shown[i]),
                    ),
                  ),
          ),
        ]),
      ),
    );
  }
}
