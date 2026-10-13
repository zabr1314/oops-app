package com.oops.app.audio

import android.content.Context
import com.oops.app.BuildConfig

/**
 * What the Soundcore SDK needs to authenticate. The token and licence come from Anker's cloud
 * (`POST /v1/third_party_sdk/get_token`); that call needs the contest app_key, so it belongs on our
 * backend, never in the APK. Until that endpoint exists they are read from android/local.properties.
 */
data class BeanAuth(
    val userId: String,
    val deviceId: String,
    val token: String,
    val licenseJson: String,
    val licenseSignature: String,
    val production: Boolean,
    /** Only connect to this bean when set; otherwise the first one found. */
    val macAddress: String = "",
) {
    val complete get() = listOf(userId, deviceId, token, licenseJson, licenseSignature).all { it.isNotBlank() }

    companion object {
        fun fromBuildConfig() = BeanAuth(
            BuildConfig.BEAN_USER_ID, BuildConfig.BEAN_DEVICE_ID, BuildConfig.BEAN_TOKEN,
            BuildConfig.BEAN_LICENSE_JSON, BuildConfig.BEAN_LICENSE_SIGNATURE,
            BuildConfig.BEAN_PRODUCTION, BuildConfig.BEAN_MAC,
        )
    }
}

/** Finds the SDK-backed link when this build includes the Soundcore SDK (see app/build.gradle.kts). */
object BeanSdk {
    private const val LINK_CLASS = "com.oops.app.audio.SoundcoreBeanLink"

    val included: Boolean by lazy { runCatching { Class.forName(LINK_CLASS) }.isSuccess }

    fun link(context: Context, auth: BeanAuth): BeanLink {
        check(included) { "这个安装包没有包含录音豆 SDK" }
        check(auth.complete) { "缺少录音豆鉴权信息（token / license），请先向安克获取" }
        return Class.forName(LINK_CLASS).getConstructor(Context::class.java, BeanAuth::class.java)
            .newInstance(context, auth) as BeanLink
    }
}
