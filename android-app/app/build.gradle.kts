import java.util.Properties

plugins { alias(libs.plugins.android.application) }

val signingFile = file(System.getenv("WORKBENCH_SIGNING_PROPERTIES")
    ?: "${System.getProperty("user.home")}/.config/paseo-pocket/android-signing.properties")
val signing = Properties().apply { if (signingFile.isFile) signingFile.inputStream().use(::load) }

android {
    namespace = "dev.paseo.pocket"
    compileSdk = 37
    defaultConfig {
        applicationId = "dev.paseo.pocket"
        minSdk = 26
        targetSdk = 37
        versionCode = 1
        versionName = "0.1.0"
        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }
    if (signing.isNotEmpty()) signingConfigs.create("persistent") {
        storeFile = file(signing.getProperty("storeFile"))
        storePassword = signing.getProperty("storePassword")
        keyAlias = signing.getProperty("keyAlias")
        keyPassword = signing.getProperty("keyPassword")
    }
    buildTypes {
        release {
            isMinifyEnabled = false
            if (signing.isNotEmpty()) signingConfig = signingConfigs.getByName("persistent")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    lint { abortOnError = true }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    implementation(libs.appcompat)
    implementation(libs.activity)
    implementation(libs.core)
    implementation(libs.material)
    implementation(libs.webkit)
    implementation(libs.compress)
    testImplementation(libs.junit)
    androidTestImplementation(libs.test.runner)
    androidTestImplementation(libs.test.junit)
}

tasks.register("requireReleaseSigning") {
    doLast { check(signing.isNotEmpty()) { "Create a persistent key with scripts/create-signing-key.mjs before release packaging." } }
}
tasks.matching { it.name == "validateSigningRelease" || it.name == "packageRelease" }.configureEach {
    dependsOn("requireReleaseSigning")
}

val prepareWebAssets by tasks.registering(Exec::class) {
    val tools = rootProject.file("../web-assets")
    inputs.files(fileTree(tools) { include("src/**", "licenses/**", "*.json") })
    outputs.dir("src/main/assets/paseo")
    outputs.dir("src/main/assets/legal")
    workingDir(tools)
    commandLine("node", "src/bundle.mjs")
}
tasks.named("preBuild") { dependsOn(prepareWebAssets) }
