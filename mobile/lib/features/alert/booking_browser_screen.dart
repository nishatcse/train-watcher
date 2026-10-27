import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';
import 'package:webview_flutter/webview_flutter.dart';

/// The official booking site inside the app. It shares storage with the Railway login
/// screen, so after logging in there the owner is already signed in here. Payment
/// pages that hand off to another app (bKash, cards, banking apps) are passed to Android.
class BookingBrowserScreen extends StatefulWidget {
  const BookingBrowserScreen({super.key, required this.url});
  final String url;
  @override
  State<BookingBrowserScreen> createState() => _BookingBrowserScreenState();
}

class _BookingBrowserScreenState extends State<BookingBrowserScreen> {
  late final WebViewController _c;
  int _progress = 0;
  String? _error;

  @override
  void initState() {
    super.initState();
    _c = WebViewController()
      ..setJavaScriptMode(JavaScriptMode.unrestricted)
      ..setNavigationDelegate(NavigationDelegate(
        onProgress: (p) => mounted ? setState(() => _progress = p) : null,
        onPageStarted: (_) => mounted ? setState(() => _error = null) : null,
        onWebResourceError: (e) {
          if (e.isForMainFrame ?? false) setState(() => _error = e.description);
        },
        onNavigationRequest: (req) {
          final u = Uri.tryParse(req.url);
          if (u != null && u.scheme != 'http' && u.scheme != 'https' && u.scheme != 'about' && u.scheme != 'data') {
            launchUrl(u, mode: LaunchMode.externalApplication).catchError((_) => false);
            return NavigationDecision.prevent;
          }
          return NavigationDecision.navigate;
        },
      ))
      ..loadRequest(Uri.parse(widget.url));
  }

  Future<void> _chrome() async {
    final current = await _c.currentUrl() ?? widget.url;
    await launchUrl(Uri.parse(current), mode: LaunchMode.externalApplication);
  }

  @override
  Widget build(BuildContext context) {
    return PopScope(
      canPop: false,
      onPopInvokedWithResult: (didPop, _) async {
        if (didPop) return;
        if (await _c.canGoBack()) {
          _c.goBack();
        } else if (context.mounted) {
          Navigator.pop(context);
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('Official booking site'),
          actions: [
            IconButton(onPressed: () => _c.reload(), icon: const Icon(Icons.refresh), tooltip: 'Reload'),
            IconButton(onPressed: _chrome, icon: const Icon(Icons.open_in_browser), tooltip: 'Open in Chrome'),
          ],
          bottom: _progress < 100 ? PreferredSize(preferredSize: const Size.fromHeight(3), child: LinearProgressIndicator(value: _progress / 100)) : null,
        ),
        body: _error != null
            ? Center(
                child: Padding(
                  padding: const EdgeInsets.all(24),
                  child: Column(mainAxisSize: MainAxisSize.min, children: [
                    const Icon(Icons.wifi_off, size: 48),
                    const SizedBox(height: 12),
                    Text("The page didn't load: $_error", textAlign: TextAlign.center),
                    const SizedBox(height: 16),
                    FilledButton(onPressed: () => _c.reload(), child: const Text('Try again')),
                    TextButton(onPressed: _chrome, child: const Text('Open in Chrome instead')),
                  ]),
                ),
              )
            : WebViewWidget(controller: _c),
      ),
    );
  }
}
