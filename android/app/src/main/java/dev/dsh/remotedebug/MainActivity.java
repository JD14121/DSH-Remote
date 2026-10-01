package dev.dsh.remotedebug;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Intent;
import android.content.res.Configuration;
import android.graphics.Color;
import android.net.Uri;
import android.os.Bundle;
import android.security.KeyChain;
import android.security.KeyChainAliasCallback;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.ClientCertRequest;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.TextView;

import java.security.PrivateKey;
import java.security.cert.X509Certificate;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * The DSH Remote USB debug harness.
 *
 * A single WebView pointed at the local R8 shell over {@code adb reverse}. This is a DEVELOPMENT
 * SHELL for driving the loopback stack from a real phone; it is not a product build and makes no
 * attempt to be one.
 *
 * What it deliberately enables, and why each is needed:
 *
 * <ul>
 *   <li><b>JavaScript + DOM storage</b> — the shell is an ES-module application; without both it
 *       does not run at all.</li>
 *   <li><b>WebView debugging</b> — so {@code chrome://inspect} can attach. The whole point of a
 *       debug harness is being able to see what the page is doing.</li>
 *   <li><b>File chooser</b> — the composer has an upload control; a WebView silently ignores
 *       {@code <input type=file>} unless a {@link WebChromeClient} supplies one.</li>
 *   <li><b>Back-button handling</b> — otherwise the first press exits the app instead of closing
 *       the drawer or navigating back inside the page.</li>
 * </ul>
 *
 * What it deliberately does not do: it requests no permission beyond {@code INTERNET}, enables no
 * file-system access, exposes no JavaScript bridge, and permits cleartext only to loopback.
 */
public class MainActivity extends Activity {

    /** The loopback origin. Reached on the device through {@code adb reverse tcp:8099 tcp:8099}. */
    private static final String START_URL = "http://localhost:8099/";
    /** Fixed relay launch URL, compiled only into the distinct relay application variant. */
    private static final String PRODUCTION_RELAY_URL = "https://relay.drm-jd.com/";

    /** Only a KeyChain alias reference is retained; private key material stays in Android KeyChain. */
    private static final String CLIENT_CERT_ALIAS_KEY = "relay_client_cert_alias";
    private static final String CLIENT_CERT_HOST = "relay.drm-jd.com";
    private static final int CLIENT_CERT_PORT = 443;

    private static final String TAG = "DshRemoteDebug";

    /** Request code for the system file picker. */
    private static final int REQUEST_FILE = 1001;

    private WebView webView;
    /** Prevent a failed main-frame navigation from being hidden by its later onPageFinished. */
    private boolean mainFrameLoadFailed;

    /** Pending callback from {@code <input type=file>}; single-use, per the WebView contract. */
    private ValueCallback<Uri[]> fileCallback;

    /** A lightweight overlay shown when the shell cannot be reached at all. */
    private TextView statusView;

    /** KeyChain lookups can block and therefore run away from WebView's UI thread. */
    private final ExecutorService keyChainExecutor = Executors.newSingleThreadExecutor();

    /** Requests waiting for the one explicit system alias chooser, all for the same pinned origin. */
    private final List<ClientCertRequest> pendingClientCertRequests = new ArrayList<>();
    private boolean clientCertAliasChooserActive;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.parseColor("#0F1115"));
        // Keep the WebView inside the system bars. Without this the window is laid out edge to
        // edge and the shell's bottom edge — the composer — sits under the navigation bar: the
        // credential scrim measured 770 of 844 available pixels, and the composer was partly
        // obscured. The page declares `viewport-fit=cover`, so it still handles its own insets.
        root.setFitsSystemWindows(true);
        root.setLayoutParams(new ViewGroup.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.parseColor("#0F1115"));

        statusView = new TextView(this);
        statusView.setTextColor(Color.parseColor("#E8ECF4"));
        statusView.setTextSize(14f);
        statusView.setPadding(48, 96, 48, 48);
        statusView.setBackgroundColor(Color.parseColor("#0F1115"));
        statusView.setVisibility(View.GONE);
        statusView.setClickable(true);
        statusView.setFocusable(true);
        statusView.setOnClickListener(view -> loadShell());
        statusView.setLayoutParams(new FrameLayout.LayoutParams(
                ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        root.addView(webView);
        root.addView(statusView);
        setContentView(root);

        configureWebView();
        loadShell();
    }

    /**
     * Apply the settings the shell requires.
     *
     * Every setting here is load-bearing for the R8 UI; none is a convenience.
     */
    private void configureWebView() {
        WebSettings settings = webView.getSettings();

        // Required: the shell is an ES-module application.
        settings.setJavaScriptEnabled(true);

        // Required: the credential lives in sessionStorage. Without DOM storage the token cannot
        // be held at all, and every reload would re-prompt.
        settings.setDomStorageEnabled(true);

        // The shell is a single self-contained document; no database or file access is needed.
        settings.setDatabaseEnabled(false);
        settings.setAllowFileAccess(false);
        settings.setAllowContentAccess(false);

        // Honour the page's own `<meta name="viewport" content="width=device-width">`.
        //
        // This MUST be true. With `setUseWideViewPort(false)` the WebView discards the meta tag and
        // falls back to a ~980px layout viewport, so a 393px phone reported a CSS width of 980px
        // and the >=768px tablet media query matched — the harness rendered the persistent session
        // rail and the content-max-width cap on a phone. Zoom stays disabled below, so enabling the
        // wide-viewport flag does not imply a zoomable page.
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(false);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);

        // The composer is a textarea; form autofill would fight it.
        settings.setSaveFormData(false);
        settings.setSupportMultipleWindows(false);
        settings.setJavaScriptCanOpenWindowsAutomatically(false);

        // Debugging attachment: the reason this harness exists.
        WebView.setWebContentsDebuggingEnabled(BuildConfig.WEBVIEW_DEBUGGING_ENABLED);

        // The shell never sets a cookie (the credential is sessionStorage, not a cookie), but
        // cookies must be enabled for the WebView's own same-origin behaviour to work normally.
        CookieManager.getInstance().setAcceptCookie(true);

        // A recognisable UA so the dev server log can tell the harness apart from a browser.
        String base = settings.getUserAgentString();
        settings.setUserAgentString(base + " DshRemoteDebug/1.0");

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedClientCertRequest(WebView view, ClientCertRequest request) {
                if (!isProductionClientCertificateRequest(request.getHost(), request.getPort())) {
                    request.cancel();
                    return;
                }

                String alias = getPreferences(MODE_PRIVATE).getString(CLIENT_CERT_ALIAS_KEY, null);
                if (alias != null && !alias.trim().isEmpty()) {
                    resolveClientIdentity(request, alias);
                    return;
                }

                // The user must select the identity in Android's system UI. No certificate is
                // selected implicitly, and the chooser is scoped to the one production origin.
                pendingClientCertRequests.add(request);
                if (!clientCertAliasChooserActive) {
                    clientCertAliasChooserActive = true;
                    try {
                        KeyChain.choosePrivateKeyAlias(
                                MainActivity.this,
                                new KeyChainAliasCallback() {
                                    @Override
                                    public void alias(String selectedAlias) {
                                        clientCertAliasChooserActive = false;
                                        List<ClientCertRequest> waiting = new ArrayList<>(pendingClientCertRequests);
                                        pendingClientCertRequests.clear();
                                        if (selectedAlias == null || selectedAlias.trim().isEmpty()) {
                                            for (ClientCertRequest waitingRequest : waiting) {
                                                waitingRequest.cancel();
                                            }
                                            return;
                                        }

                                        // Persist only Android's opaque KeyChain alias, never key or
                                        // certificate bytes. Enrollment/import remains system mediated.
                                        getPreferences(MODE_PRIVATE).edit()
                                                .putString(CLIENT_CERT_ALIAS_KEY, selectedAlias)
                                                .apply();
                                        for (ClientCertRequest waitingRequest : waiting) {
                                            resolveClientIdentity(waitingRequest, selectedAlias);
                                        }
                                    }
                                },
                                null,
                                null,
                                request.getHost(),
                                request.getPort(),
                                null);
                    } catch (Exception exception) {
                        clientCertAliasChooserActive = false;
                        List<ClientCertRequest> waiting = new ArrayList<>(pendingClientCertRequests);
                        pendingClientCertRequests.clear();
                        Log.w(TAG, "KeyChain alias chooser unavailable", exception);
                        for (ClientCertRequest waitingRequest : waiting) {
                            waitingRequest.cancel();
                        }
                    }
                }
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // The harness exists to drive the local shell. Anything leaving loopback is handed
                // to the system browser rather than rendered inside the harness.
                Uri uri = request.getUrl();
                String host = uri.getHost();
                if (host != null && (host.equals("localhost") || host.equals("127.0.0.1"))) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (Exception ignored) {
                    // No handler for the scheme; staying put is the safe outcome.
                }
                return true;
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                if (mainFrameLoadFailed) return;
                statusView.setVisibility(View.GONE);
                webView.setVisibility(View.VISIBLE);
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                // Only a main-frame failure is worth reporting; a failed favicon is not.
                if (request != null && request.isForMainFrame()) {
                    mainFrameLoadFailed = true;
                    showUnreachable(error != null ? String.valueOf(error.getDescription()) : "unknown error");
                }
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                // A WebView ignores <input type=file> without this, so the composer's upload
                // control would silently do nothing.
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;

                Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
                intent.addCategory(Intent.CATEGORY_OPENABLE);
                // Only the system picker grants access to the single chosen item, so the harness
                // needs no storage permission at all.
                intent.setType("*/*");
                if (params != null && params.getAcceptTypes() != null && params.getAcceptTypes().length > 0) {
                    String[] accepted = params.getAcceptTypes();
                    if (accepted.length == 1 && accepted[0] != null && !accepted[0].isEmpty()) {
                        intent.setType(accepted[0]);
                    } else {
                        intent.putExtra(Intent.EXTRA_MIME_TYPES, accepted);
                    }
                }
                try {
                    startActivityForResult(Intent.createChooser(intent, getString(R.string.choose_file)), REQUEST_FILE);
                } catch (Exception exception) {
                    fileCallback = null;
                    return false;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                // Route page console output to logcat so a failure is visible from the terminal
                // without attaching a debugger.
                Log.d(TAG, "console: " + message.message() + " @" + message.lineNumber());
                return true;
            }
        });
    }

    /** True only for the production relay's exact TLS authority. */
    private static boolean isProductionClientCertificateRequest(String host, int port) {
        return host != null && CLIENT_CERT_HOST.equalsIgnoreCase(host) && port == CLIENT_CERT_PORT;
    }

    /** Resolve a user-selected Android KeyChain identity and fail closed on any incomplete identity. */
    private void resolveClientIdentity(ClientCertRequest request, String alias) {
        try {
            keyChainExecutor.execute(() -> {
                PrivateKey privateKey = null;
                X509Certificate[] chain = null;
                try {
                    privateKey = KeyChain.getPrivateKey(MainActivity.this, alias);
                    chain = KeyChain.getCertificateChain(MainActivity.this, alias);
                } catch (Exception exception) {
                    Log.w(TAG, "Unable to resolve selected KeyChain identity", exception);
                }

                PrivateKey resolvedKey = privateKey;
                X509Certificate[] resolvedChain = chain;
                runOnUiThread(() -> {
                    if (!hasUsableClientIdentity(resolvedKey, resolvedChain)) {
                        // Let the next production challenge show the chooser again if the saved
                        // alias was removed or no longer contains a usable identity.
                        getPreferences(MODE_PRIVATE).edit().remove(CLIENT_CERT_ALIAS_KEY).apply();
                        request.cancel();
                        return;
                    }
                    request.proceed(resolvedKey, resolvedChain);
                });
            });
        } catch (RuntimeException exception) {
            Log.w(TAG, "Unable to schedule KeyChain lookup", exception);
            request.cancel();
        }
    }

    private static boolean hasUsableClientIdentity(PrivateKey privateKey, X509Certificate[] chain) {
        if (privateKey == null || chain == null || chain.length == 0) {
            return false;
        }
        for (X509Certificate certificate : chain) {
            if (certificate == null) {
                return false;
            }
        }
        return true;
    }

    /**
     * Whether the shell is already on screen.
     *
     * @return true when a page has been loaded.
     */
    private boolean shellLoaded() {
        return webView != null && webView.getUrl() != null;
    }

    /** Load the shell. */
    private void loadShell() {
        mainFrameLoadFailed = false;
        statusView.setVisibility(View.GONE);
        webView.setVisibility(View.VISIBLE);
        webView.loadUrl(resolveStartUrl());
    }

    private String resolveStartUrl() {
        return BuildConfig.REMOTE_RELAY ? PRODUCTION_RELAY_URL : START_URL;
    }

    /**
     * Explain an unreachable shell in terms the operator can act on.
     *
     * @param detail the underlying error description.
     */
    private void showUnreachable(String detail) {
        statusView.setText(getString(R.string.unreachable, detail));
        statusView.setVisibility(View.VISIBLE);
        webView.setVisibility(View.GONE);
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (webView != null && !resolveStartUrl().equals(webView.getUrl())) {
            webView.loadUrl(resolveStartUrl());
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null && !shellLoaded()) {
            loadShell();
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE) {
;
            Uri[] result = null;
            if (resultCode == RESULT_OK && data != null) {
                if (data.getClipData() != null) {
                    int count = data.getClipData().getItemCount();
                    result = new Uri[count];
                    for (int index = 0; index < count; index++) {
                        result[index] = data.getClipData().getItemAt(index).getUri();
                    }
                } else if (data.getData() != null) {
                    result = new Uri[]{data.getData()};
                }
            }
            if (fileCallback != null) {
                fileCallback.onReceiveValue(result);
                // The callback is single-use: clear it so a later chooser gets a fresh one.
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /**
     * Ask the page what the back press should act on.
     *
     * The page answers `drawer`, `dialog` or `none` — precedence decided in one place, where the
     * DOM is, rather than guessed at from Java.
     *
     * The first version of this checked only for the credential dialog and then re-dispatched
     * Escape, which was wrong in two ways: it never considered the session drawer, and the
     * credential dialog does not close on Escape, so the key press was swallowed and back appeared
     * to do nothing. Measured on-device with the drawer open, the drawer stayed open.
     */
    private static final String BACK_STATE_JS =
            "(function(){"
                    + "var d=document.querySelector('.drawer');"
                    + "if(d&&d.dataset.state==='open')return 'drawer:open';"
                    + "var s=document.querySelector('.drawer-scrim');"
                    + "if(s&&getComputedStyle(s).display!=='none'&&!s.hidden)return 'drawer:scrim';"
                    + "var c=document.querySelector('.dialog-scrim');"
                    + "if(c&&getComputedStyle(c).display!=='none')return 'dialog';"
                    + "return 'none';"
                    + "})()";

    /** Ask the page to close whatever overlay is open. */
    private static final String CLOSE_OVERLAY_JS =
            "(function(){"
                    + "var d=document.querySelector('.drawer');"
                    + "if(d&&d.dataset.state==='open'){"
                    + "var t=document.querySelector('.drawer-scrim')||d;"
                    + "t.click();return 'closed-drawer';}"
                    + "var c=document.querySelector('.dialog-scrim');"
                    + "if(c&&getComputedStyle(c).display!=='none'){"
                    + "var b=document.querySelector('.dialog button');if(b){b.click();return 'closed-dialog';}}"
                    + "return 'nothing';"
                    + "})()";

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(BACK_STATE_JS, value -> {
            String state = value == null ? "none" : value.replace("\"", "");
            if (state.startsWith("drawer") || state.equals("dialog")) {
                // An overlay is showing: close it in the page and keep the operator where they are.
                webView.evaluateJavascript(CLOSE_OVERLAY_JS, null);
                return;
            }
            if (webView.canGoBack()) {
                webView.goBack();
                return;
            }
            finish();
        });
    }

    @Override
    public void onConfigurationChanged(Configuration newConfig) {
        // The manifest declares orientation|screenSize so the WebView is re-laid out rather than
        // recreated, which keeps the DOM, the draft and the session alive across a rotation.
        super.onConfigurationChanged(newConfig);
    }

    @Override
    protected void onDestroy() {
        for (ClientCertRequest request : pendingClientCertRequests) {
            request.cancel();
        }
        pendingClientCertRequests.clear();
        keyChainExecutor.shutdownNow();
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
