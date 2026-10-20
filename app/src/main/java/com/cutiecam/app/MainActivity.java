package com.cutiecam.app;

import android.Manifest;
import android.app.Activity;
import android.content.ContentResolver;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import androidx.webkit.WebViewAssetLoader;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * Cutie Cam: a full-screen WebView that runs the camera app from the APK's own files
 * (assets/www). Nothing is loaded from the internet. This class only adds what a web
 * page can't do on its own: camera/mic permission, saving to the Gallery, and sharing.
 */
public class MainActivity extends Activity {

    private static final String HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + HOST + "/app/index.html";
    private static final String[] PERMS = {Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO};
    private static final int REQ_PERMS = 7;

    private WebView web;
    private PermissionRequest pendingWebRequest;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(0xFF1D1626);
        web = new WebView(this);
        web.setBackgroundColor(0xFF1D1626);
        root.addView(web, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        setContentView(root);
        keepClearOfSystemBars(root);

        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setAllowFileAccess(false);
        s.setAllowContentAccess(false);

        final WebViewAssetLoader loader = new WebViewAssetLoader.Builder()
                .setDomain(HOST)
                .addPathHandler("/app/", new AppFiles(this))
                .build();

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return loader.shouldInterceptRequest(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // never navigate away from the app's own pages
                return !HOST.equals(request.getUrl().getHost());
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(final PermissionRequest request) {
                runOnUiThread(() -> {
                    if (hasPermissions()) {
                        request.grant(request.getResources());
                    } else {
                        pendingWebRequest = request;
                        requestPermissions(PERMS, REQ_PERMS);
                    }
                });
            }
        });

        web.addJavascriptInterface(new Bridge(), "CutieNative");

        if (!hasPermissions()) requestPermissions(PERMS, REQ_PERMS);
        web.loadUrl(START_URL);
    }

    /** Android 15+ draws apps under the status and navigation bars; pad so buttons stay clear. */
    private void keepClearOfSystemBars(View root) {
        if (Build.VERSION.SDK_INT < 35) return;
        root.setOnApplyWindowInsetsListener((v, insets) -> {
            Insets b = insets.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            v.setPadding(b.left, b.top, b.right, b.bottom);
            return insets;
        });
    }

    private boolean hasPermissions() {
        for (String p : PERMS) {
            if (checkSelfPermission(p) != PackageManager.PERMISSION_GRANTED) return false;
        }
        return true;
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_PERMS || pendingWebRequest == null) return;
        if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
            pendingWebRequest.grant(pendingWebRequest.getResources());
        } else {
            pendingWebRequest.deny();
        }
        pendingWebRequest = null;
    }

    @Override
    @SuppressWarnings("deprecation")
    public void onBackPressed() {
        web.evaluateJavascript("window.cutieBack ? window.cutieBack() : false", value -> {
            if (!"true".equals(value)) finish();
        });
    }

    @Override
    protected void onDestroy() {
        if (web != null) web.destroy();
        super.onDestroy();
    }

    /** Serves files from assets/www with the right content types (needed for .wasm and modules). */
    private static class AppFiles implements WebViewAssetLoader.PathHandler {
        private final Context context;

        AppFiles(Context context) {
            this.context = context.getApplicationContext();
        }

        @Override
        public WebResourceResponse handle(String path) {
            if (path.isEmpty()) path = "index.html";
            try {
                InputStream in = context.getAssets().open("www/" + path);
                String mime = mimeFor(path);
                String enc = mime.startsWith("text/") || mime.endsWith("javascript") ? "utf-8" : null;
                WebResourceResponse r = new WebResourceResponse(mime, enc, in);
                Map<String, String> headers = new HashMap<>();
                headers.put("Cache-Control", "no-cache");
                r.setResponseHeaders(headers);
                return r;
            } catch (IOException e) {
                return null;
            }
        }

        private static String mimeFor(String p) {
            String f = p.toLowerCase();
            if (f.endsWith(".html")) return "text/html";
            if (f.endsWith(".js") || f.endsWith(".mjs")) return "text/javascript";
            if (f.endsWith(".wasm")) return "application/wasm";
            if (f.endsWith(".css")) return "text/css";
            if (f.endsWith(".json")) return "application/json";
            if (f.endsWith(".png")) return "image/png";
            if (f.endsWith(".svg")) return "image/svg+xml";
            return "application/octet-stream";
        }
    }

    /** Called from app.js as window.CutieNative.* */
    private class Bridge {
        private OutputStream out;
        private Uri uri;

        @JavascriptInterface
        public synchronized String begin(String name, String mime) {
            try {
                closeQuietly();
                boolean isVideo = mime.startsWith("video");
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.DISPLAY_NAME, name);
                v.put(MediaStore.MediaColumns.MIME_TYPE, mime);
                v.put(MediaStore.MediaColumns.RELATIVE_PATH,
                        (isVideo ? Environment.DIRECTORY_MOVIES : Environment.DIRECTORY_PICTURES) + "/CutieCam");
                v.put(MediaStore.MediaColumns.IS_PENDING, 1);
                Uri collection = isVideo
                        ? MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY)
                        : MediaStore.Images.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY);
                ContentResolver cr = getContentResolver();
                uri = cr.insert(collection, v);
                if (uri == null) return "Gallery refused the file";
                out = cr.openOutputStream(uri);
                return out == null ? "Couldn't open the file" : "ok";
            } catch (Exception e) {
                return String.valueOf(e.getMessage());
            }
        }

        @JavascriptInterface
        public synchronized boolean append(String base64) {
            try {
                out.write(Base64.decode(base64, Base64.DEFAULT));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        @JavascriptInterface
        public synchronized String finish() {
            try {
                out.close();
                out = null;
                ContentValues v = new ContentValues();
                v.put(MediaStore.MediaColumns.IS_PENDING, 0);
                getContentResolver().update(uri, v, null, null);
                return uri.toString();
            } catch (Exception e) {
                return "";
            }
        }

        @JavascriptInterface
        public void share(String uriString, String mime) {
            runOnUiThread(() -> {
                Uri u = Uri.parse(uriString);
                Intent send = new Intent(Intent.ACTION_SEND);
                send.setType(mime);
                send.putExtra(Intent.EXTRA_STREAM, u);
                send.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                startActivity(Intent.createChooser(send, "Share to"));
            });
        }

        private void closeQuietly() {
            try {
                if (out != null) out.close();
            } catch (IOException ignored) {
            }
            out = null;
        }
    }
}
