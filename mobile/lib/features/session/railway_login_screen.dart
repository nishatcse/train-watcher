import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:webview_flutter/webview_flutter.dart';

import '../../core/config.dart';
import '../../core/providers.dart';
import '../../widgets/common.dart';

/// The owner logs in on the REAL Railway page, typing their own password and passing
/// the site's own check themselves. The app never sees the password: it only reads
/// the session the site stores in the browser afterwards and sends that to the backend.
class RailwayLoginScreen extends ConsumerStatefulWidget {
  const RailwayLoginScreen({super.key});
  @override
  ConsumerState<RailwayLoginScreen> createState() => _RailwayLoginScreenState();
}

class _RailwayLoginScreenState extends ConsumerState<RailwayLoginScreen> {
  late final WebViewController _c;
  Timer? _poll;
  bool _uploading = false;
  bool _ready = false;
  String _hint = 'Log in below with your own account.';
  int _progress = 0;

  // Reads exactly what the site's own app keeps in localStorage after a login.
  static const _readJs = r'''(function(){try{
    var o={};['token','ssdk','uudid','user','handshake_data','handshake_hash'].forEach(function(k){o[k]=localStorage.getItem(k);});
    for(var i=0;i<localStorage.length;i++){var k=localStorage.key(i);if(/refresh/i.test(k)){o.refresh_token=localStorage.getItem(k);}}
    return JSON.stringify(o);}catch(e){return '{}';}})()''';

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(onProgress: (p) => mounted ? setState(() => _progress = p) : null));
    _start();
  }

  Future<void> _start() async {
    // A clean start gives a fresh device handshake, exactly like a first visit.
    await _c.clearLocalStorage();
    await WebViewCookieManager().clearCookies();
    await _c.loadRequest(Uri.parse(kRailwayLoginUrl));
    if (!mounted) return;
    setState(() => _ready = true);
    _poll = Timer.periodic(const Duration(milliseconds: 1500), (_) => _check());
  }

  @override
  void dispose() {
    _poll?.cancel();
    super.dispose();
  }

  Map<String, dynamic>? _parse(Object raw) {
    try {
      var text = raw.toString();
      // Android hands the JS string back JSON-quoted.
      if (text.startsWith('"')) text = jsonDecode(text) as String;
      return (jsonDecode(text) as Map).cast<String, dynamic>();
    } catch (_) {
      return null;
    }
  }

  Future<void> _check() async {
    if (_uploading || !mounted) return;
    Object raw;
    try {
      raw = await _c.runJavaScriptReturningResult(_readJs);
    } catch (_) {
      return;
    }
    final s = _parse(raw);
    final token = s?['token'] as String?;
    if (s == null || token == null || token.isEmpty || (s['ssdk'] as String? ?? '').isEmpty || (s['uudid'] as String? ?? '').isEmpty) return;

    setState(() {
      _uploading = true;
      _hint = 'Logged in. Sending the session to your server…';
    });
    _poll?.cancel();
    try {
      final body = <String, dynamic>{for (final e in s.entries) if (e.value != null && e.value.toString().isNotEmpty) e.key: e.value};
      final status = await ref.read(apiProvider).postSession(body);
      ref.invalidate(statusProvider);
      ref.invalidate(catalogProvider);
      if (!mounted) return;
      snack(context, 'Logged in. Monitoring resumes (valid for about ${(status.secondsLeft ?? 0) ~/ 3600}h).');
      Navigator.pop(context, true);
    } catch (e) {
      if (!mounted) return;
      setState(() {
        _uploading = false;
        _hint = 'Logged in, but the server refused it: ${friendlyError(e)}';
      });
      _poll = Timer.periodic(const Duration(seconds: 4), (_) => _check());
    }
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: const Text('Log in to Railway'),
        bottom: _progress < 100 ? PreferredSize(preferredSize: const Size.fromHeight(3), child: LinearProgressIndicator(value: _progress / 100)) : null,
      ),
      body: Column(children: [
        Material(
          color: Theme.of(context).colorScheme.secondaryContainer,
          child: Padding(
            padding: const EdgeInsets.all(12),
            child: Row(children: [
              if (_uploading) const Padding(padding: EdgeInsets.only(right: 12), child: SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2))) else const Padding(padding: EdgeInsets.only(right: 12), child: Icon(Icons.lock_outline, size: 18)),
              Expanded(child: Text('$_hint\nYour password stays on this page and is never sent to your server.', style: const TextStyle(fontSize: 13))),
            ]),
          ),
        ),
        Expanded(child: _ready ? WebViewWidget(controller: _c) : const Center(child: CircularProgressIndicator())),
      ]),
    );
  }
}
