import java.util.Properties

plugins { alias(libs.plugins.android.application) }

val signingFile = file(System.getenv("PASEO_POCKET_SIGNING_PROPERTIES")
    ?: "${System.getProperty("user.home")}/.config/paseo-pocket/android-signing.properties")
val signing = Properties().apply { if (signingFile.isFile) signingFile.inputStream().use(::load) }
val appVersion = Properties().apply { rootProject.file("version.properties").inputStream().use(::load) }
val appVersionName = appVersion.getProperty("versionName")
val appVersionCode = appVersion.getProperty("versionCode").toInt()
val isolatedQa = providers.gradleProperty("pocketTestPackage").orNull?.let {
    require(it == "dev.paseo.pocket.qa") { "Only the isolated QA package is supported" }
    true
} ?: false
require(Regex("(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)").matches(appVersionName)) { "Invalid Android versionName" }
require(appVersionCode in 1..2100000000) { "Invalid Android versionCode" }

android {
    namespace = "dev.paseo.pocket"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.paseo.pocket"
        minSdk = 26
        targetSdk = 37
        versionCode = appVersionCode
        versionName = appVersionName
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    if (signing.isNotEmpty()) signingConfigs.create("persistent") {
        storeFile = file(signing.getProperty("storeFile"))
        storePassword = signing.getProperty("storePassword")
        keyAlias = signing.getProperty("keyAlias")
        keyPassword = signing.getProperty("keyPassword")
    }
    buildTypes {
        getByName("debug") { if (isolatedQa) applicationIdSuffix = ".qa" }
        release {
            isMinifyEnabled = false
            if (signing.isNotEmpty()) signingConfig = signingConfigs.getByName("persistent")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures { buildConfig = true }
    // AAPT's default !_* directory rule silently drops Expo's complete JS/font tree.
    androidResources { ignoreAssetsPattern = "!.svn:!.git:!.ds_store:!*.scc:.*:CVS:thumbs.db:picasa.ini:*~" }
    lint { abortOnError = true }
    testOptions { unitTests.isReturnDefaultValues = true }
    sourceSets.getByName("debug").res.srcDir(rootProject.file("build/device-fixtures/res"))
}

dependencies {
    implementation(libs.appcompat)
    implementation(libs.activity)
    implementation(libs.core)
    implementation(libs.material)
    implementation(libs.webkit)
    implementation(libs.compress)
    testImplementation(libs.junit)
    testImplementation("org.json:json:20250517")
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.junit)
    androidTestImplementation("androidx.test.uiautomator:uiautomator:2.3.0")
}

tasks.register("requireReleaseSigning") {
    doLast { check(signing.isNotEmpty()) { "Create a persistent key with scripts/create-signing-key.mjs before release packaging." } }
}
tasks.matching { it.name == "validateSigningRelease" || it.name == "packageRelease" }.configureEach {
    dependsOn("requireReleaseSigning")
}

val prepareWebAssets = tasks.register<Exec>("prepareWebAssets") {
    val tools = rootProject.file("../web-assets")
    inputs.files(fileTree(tools) { include("src/**", "licenses/**", "*.json") })
    outputs.dir("src/main/assets/paseo")
    outputs.dir("src/main/assets/legal")
    workingDir(tools)
    commandLine("node", "src/bundle.mjs")
}
tasks.named("preBuild") { dependsOn(prepareWebAssets) }

val prepareDeviceFixtures = tasks.register<Exec>("prepareDeviceFixtures") {
    inputs.file(rootProject.file("scripts/prepare-device-fixtures.mjs"))
    outputs.dir(rootProject.file("build/device-fixtures/res"))
    outputs.files(rootProject.file(".device-fixtures/localhost-cert.pem"), rootProject.file(".device-fixtures/localhost-key.pem"))
    commandLine("node", rootProject.file("scripts/prepare-device-fixtures.mjs"))
}
tasks.matching { it.name == "preDebugBuild" }.configureEach { dependsOn(prepareDeviceFixtures) }
