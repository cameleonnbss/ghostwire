package com.ghostwire.app

import android.annotation.SuppressLint
import android.app.Activity
import android.os.Bundle
import android.view.View
import android.webkit.CookieManager
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ProgressBar
import android.widget.TextView

/**
 * GhostWire for Android.
 *
 * Flow: a native login screen asks for the panel address + credentials,
 * then the panel web UI loads in a WebView (cookie session kept by
 * CookieManager). No account on the panel? Leave the fields empty and
 * tap Connect - open-mode panels load directly.
 */
class MainActivity : Activity() {

    private lateinit var loginView: LinearLayout
    private lateinit var webView: WebView
    private lateinit var addressInput: EditText
    private lateinit var userInput: EditText
    private lateinit var passInput: EditText
    private lateinit var statusText: TextView
    private lateinit var progress: ProgressBar

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val prefs = getSharedPreferences("ghostwire", MODE_PRIVATE)

        val density = resources.displayMetrics.density
        fun dp(v: Int) = (v * density).toInt()

        loginView = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setBackgroundColor(0xFF06090F.toInt())
            setPadding(dp(28), dp(48), dp(28), dp(28))
        }

        fun field(hint: String, isPass: Boolean = false): EditText {
            val et = EditText(this)
            et.hint = hint
            et.setSingleLine(true)
            et.setTextColor(0xFFDCE4F2.toInt())
            et.setHintTextColor(0xFF78869E.toInt())
            et.setBackgroundColor(0xFF141C2E.toInt())
            et.setPadding(dp(14), dp(12), dp(14), dp(12))
            if (isPass) {
                et.inputType = android.text.InputType.TYPE_CLASS_TEXT or
                    android.text.InputType.TYPE_TEXT_VARIATION_PASSWORD
            }
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            et.layoutParams = lp
            return et
        }

        val title = TextView(this).apply {
            text = "GhostWire"
            textSize = 26f
            setTextColor(0xFF4F8EF7.toInt())
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(4)
            layoutParams = lp
        }
        val subtitle = TextView(this).apply {
            text = "Connect to your self-hosted VPN panel"
            textSize = 13f
            setTextColor(0xFF78869E.toInt())
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.bottomMargin = dp(18)
            layoutParams = lp
        }

        addressInput = field("Panel address (e.g. http://192.168.1.20:8080)")
        addressInput.setText(prefs.getString("address", "http://192.168.1.20:8080"))
        userInput = field("Username (empty for open panel)")
        userInput.setText(prefs.getString("username", ""))
        passInput = field("Password", isPass = true)
        statusText = TextView(this).apply {
            textSize = 13f
            setTextColor(0xFFF87171.toInt())
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(8)
            layoutParams = lp
        }
        progress = ProgressBar(this).apply {
            visibility = View.GONE
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(10)
            lp.gravity = android.view.Gravity.CENTER_HORIZONTAL
            layoutParams = lp
        }

        val connectBtn = Button(this).apply {
            text = "Connect"
            setBackgroundColor(0xFF4F8EF7.toInt())
            setTextColor(0xFFFFFFFF.toInt())
            val lp = LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT)
            lp.topMargin = dp(16)
            layoutParams = lp
        }

        loginView.addView(title)
        loginView.addView(subtitle)
        loginView.addView(addressInput)
        loginView.addView(userInput)
        loginView.addView(passInput)
        loginView.addView(statusText)
        loginView.addView(progress)
        loginView.addView(connectBtn)

        webView = WebView(this).apply {
            visibility = View.GONE
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            CookieManager.getInstance().setAcceptCookie(true)
            webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, url: String): Boolean {
                    val host = prefs.getString("address", "")
                        ?.let { runCatching { java.net.URI(it).host }.getOrNull() }
                    return host == null || !url.contains(host)
                }
            }
        }

        setContentView(loginView)

        connectBtn.setOnClickListener {
            val base = addressInput.text.toString().trim().trimEnd('/')
            if (base.isEmpty() || !base.startsWith("http")) {
                statusText.text = "Enter a valid address (http://host:port)"
                return@setOnClickListener
            }
            prefs.edit()
                .putString("address", base)
                .putString("username", userInput.text.toString().trim())
                .apply()

            statusText.text = ""
            progress.visibility = View.VISIBLE
            connectBtn.isEnabled = false

            Thread {
                val result = tryLogin(base, userInput.text.toString().trim(), passInput.text.toString())
                runOnUiThread {
                    progress.visibility = View.GONE
                    connectBtn.isEnabled = true
                    when (result) {
                        is LoginResult.Ok -> showPanel(base, result.token)
                        is LoginResult.Open -> showPanel(base, null)
                        is LoginResult.Failed -> { statusText.text = result.message }
                    }
                }
            }.start()
        }
    }

    private sealed interface LoginResult {
        data class Ok(val token: String) : LoginResult
        data object Open : LoginResult
        data class Failed(val message: String) : LoginResult
    }

    private fun tryLogin(base: String, user: String, pass: String): LoginResult = try {
        val state = fetch("$base/api/auth/state")
        if (state.contains("\"authEnabled\":false")) LoginResult.Open
        else if (user.isEmpty()) LoginResult.Failed("This panel requires an account")
        else {
            val conn = java.net.URL("$base/api/auth/login").openConnection() as java.net.HttpURLConnection
            conn.requestMethod = "POST"
            conn.doOutput = true
            conn.setRequestProperty("Content-Type", "application/json")
            conn.connectTimeout = 7000
            conn.readTimeout = 7000
            val body = org.json.JSONObject().put("username", user).put("password", pass).toString()
            conn.outputStream.use { it.write(body.toByteArray()) }
            val code = conn.responseCode
            val text = (if (code in 200..299) conn.inputStream else conn.errorStream)
                ?.bufferedReader()?.readText().orEmpty()
            if (code == 200) LoginResult.Ok(org.json.JSONObject(text).optString("token", ""))
            else LoginResult.Failed(
                runCatching { org.json.JSONObject(text).optString("error") }.getOrNull()
                    ?: "Login failed (HTTP $code)")
        }
    } catch (e: Exception) {
        LoginResult.Failed("Unreachable: ${e.message}")
    }

    private fun fetch(url: String): String =
        java.net.URL(url).openStream().bufferedReader().use { it.readText() }

    private fun showPanel(base: String, token: String?) {
        if (token != null) {
            CookieManager.getInstance().setCookie(base, "gw_session=$token; Path=/")
            CookieManager.getInstance().flush()
        }
        loginView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        setContentView(webView)
        webView.loadUrl(base)
    }

    @Deprecated("Deprecated in Java")
    @Suppress("DEPRECATION")
    override fun onBackPressed() {
        if (webView.visibility == View.VISIBLE && webView.canGoBack()) webView.goBack()
        else super.onBackPressed()
    }

    override fun onDestroy() {
        webView.destroy()
        super.onDestroy()
    }
}
