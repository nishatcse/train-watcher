import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../core/api_client.dart';
import '../../core/config.dart';
import '../../core/providers.dart';

class PairingScreen extends ConsumerStatefulWidget {
  const PairingScreen({super.key});
  @override
  ConsumerState<PairingScreen> createState() => _PairingScreenState();
}

class _PairingScreenState extends ConsumerState<PairingScreen> {
  final _code = TextEditingController();
  late final TextEditingController _url;
  bool _busy = false;
  bool _showServer = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    _url = TextEditingController(text: ref.read(authProvider).valueOrNull?.baseUrl ?? kDefaultBackendUrl);
  }

  @override
  void dispose() {
    _code.dispose();
    _url.dispose();
    super.dispose();
  }

  Future<void> _pair() async {
    final code = _code.text.trim();
    if (code.length < 6) {
      setState(() => _error = 'Enter the pairing code you were given.');
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await ref.read(authProvider.notifier).pair(baseUrl: _url.text.trim(), code: code);
    } on ApiException catch (e) {
      if (mounted) setState(() => _error = e.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context);
    return Scaffold(
      body: SafeArea(
        child: ListView(padding: const EdgeInsets.all(24), children: [
          const SizedBox(height: 32),
          Icon(Icons.train, size: 64, color: t.colorScheme.primary),
          const SizedBox(height: 16),
          Text('Connect this phone', style: t.textTheme.headlineMedium?.copyWith(fontWeight: FontWeight.w700)),
          const SizedBox(height: 8),
          Text(
            'Train Watcher watches seats in the cloud and rings this phone when one opens up. '
            'You still buy the ticket yourself on the official site.',
            style: t.textTheme.bodyLarge,
          ),
          if (ref.watch(authProvider).valueOrNull?.notice case final notice?)
            Padding(
              padding: const EdgeInsets.only(top: 16),
              child: Card(color: t.colorScheme.errorContainer, child: ListTile(leading: const Icon(Icons.link_off), title: Text(notice))),
            ),
          const SizedBox(height: 28),
          TextField(
            controller: _code,
            textCapitalization: TextCapitalization.characters,
            autocorrect: false,
            enableSuggestions: false,
            style: const TextStyle(fontSize: 24, letterSpacing: 4, fontWeight: FontWeight.w700),
            decoration: const InputDecoration(labelText: 'Pairing code', hintText: 'ABCD2345', border: OutlineInputBorder()),
            onSubmitted: (_) => _pair(),
          ),
          if (_error != null) Padding(padding: const EdgeInsets.only(top: 12), child: Text(_error!, style: TextStyle(color: t.colorScheme.error))),
          const SizedBox(height: 16),
          FilledButton.icon(
            onPressed: _busy ? null : _pair,
            icon: _busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.link),
            label: const Text('Pair this phone'),
            style: FilledButton.styleFrom(minimumSize: const Size.fromHeight(52)),
          ),
          const SizedBox(height: 12),
          Card(
            color: t.colorScheme.surfaceContainerHighest,
            child: const Padding(
              padding: EdgeInsets.all(14),
              child: Text(
                'Get a code from your server:\n'
                'curl -X POST <server>/admin/pairing-code -H "x-admin-token: <ADMIN_TOKEN>"\n'
                'It works once and expires after 10 minutes.',
                style: TextStyle(fontSize: 13),
              ),
            ),
          ),
          TextButton(onPressed: () => setState(() => _showServer = !_showServer), child: Text(_showServer ? 'Hide server address' : 'Server address')),
          if (_showServer)
            TextField(
              controller: _url,
              keyboardType: TextInputType.url,
              autocorrect: false,
              decoration: const InputDecoration(labelText: 'Server', border: OutlineInputBorder()),
            ),
        ]),
      ),
    );
  }
}
