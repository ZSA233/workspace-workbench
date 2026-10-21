.PHONY: test typecheck plugin-test plugin-typecheck backend package plugin-package check \
	version-check bump-patch bump-minor bump-major release-check help \
	android-version android-test android-check android-build android-package android-prepare \
	android-release android-retry android-signing-check android-signing-configure

.DEFAULT_GOAL := help

# Pass parameters through the environment so shell metacharacters stay literal.
export PASEO_POCKET_RELEASE_VERSION := $(value VERSION)
export PASEO_POCKET_RELEASE_TAG := $(value TAG)
export PASEO_POCKET_RELEASE_REPOSITORY := $(value REPO)

help:
	@printf '%s\n' \
		'Paseo Pocket Android:' \
		'  make android-version                       查看并检查版本' \
		'  make android-test                          发版脚本与网页资源测试' \
		'  make android-check                         版本、测试、Android JVM 与 lint' \
		'  make android-build                         构建并校验本地调试 APK' \
		'  make android-package                       构建、签名并打包本地正式 APK' \
		'  make android-prepare VERSION=0.1.3          只准备版本变更' \
		'  make android-release VERSION=0.1.3          提交版本、打 tag 并推送，触发发布' \
		'  make android-retry TAG=android-v0.1.3        重试已有 tag 的未完成发布' \
		'  make android-signing-check REPO=OWNER/REPO  检查签名配置' \
		'  make android-signing-configure REPO=OWNER/REPO  配置仓库签名 Secrets' \
		'' \
		'Workbench plugin:' \
		'  make check                                 版本、TypeScript 与插件测试' \
		'  make plugin-package                        打包插件' \
		'  make release-check TAG=vX.Y.Z               检查插件发布 tag'

android-version:
	node android-app/scripts/version.mjs --check

android-test:
	node --test android-app/scripts/test/*.test.mjs
	npm --prefix web-assets test

android-check: android-version android-test
	cd android-app && ./gradlew --no-daemon testDebugUnitTest lintDebug

android-build: android-version
	cd android-app && ./gradlew --no-daemon assembleDebug
	python3 android-app/scripts/verify-apk.py android-app/app/build/outputs/apk/debug/app-debug.apk

android-package: android-version
	cd android-app && ./gradlew --no-daemon assembleRelease
	node android-app/scripts/release.mjs package

android-prepare:
	@test -n "$$PASEO_POCKET_RELEASE_VERSION" || { echo 'usage: make android-prepare VERSION=0.1.3' >&2; exit 2; }
	node scripts/release-android.mjs --version "$$PASEO_POCKET_RELEASE_VERSION"

android-release:
	@test -n "$$PASEO_POCKET_RELEASE_VERSION" || { echo 'usage: make android-release VERSION=0.1.3' >&2; exit 2; }
	node scripts/release-android.mjs --version "$$PASEO_POCKET_RELEASE_VERSION" --publish

android-retry:
	@test -n "$$PASEO_POCKET_RELEASE_TAG" || { echo 'usage: make android-retry TAG=android-v0.1.3' >&2; exit 2; }
	gh workflow run android-release.yml --ref main -f "tag=$$PASEO_POCKET_RELEASE_TAG"

android-signing-check:
	@test -n "$$PASEO_POCKET_RELEASE_REPOSITORY" || { echo 'usage: make android-signing-check REPO=OWNER/REPO' >&2; exit 2; }
	node android-app/scripts/signing.mjs configure --repo "$$PASEO_POCKET_RELEASE_REPOSITORY" --dry-run

android-signing-configure:
	@test -n "$$PASEO_POCKET_RELEASE_REPOSITORY" || { echo 'usage: make android-signing-configure REPO=OWNER/REPO' >&2; exit 2; }
	node android-app/scripts/signing.mjs configure --repo "$$PASEO_POCKET_RELEASE_REPOSITORY"

version-check:
	node scripts/version.mjs --check

bump-patch:
	node scripts/version.mjs --bump patch

bump-minor:
	node scripts/version.mjs --bump minor

bump-major:
	node scripts/version.mjs --bump major

test:
	$(MAKE) plugin-test

typecheck:
	$(MAKE) plugin-typecheck

plugin-typecheck:
	npm --prefix paseo-plugin run typecheck

plugin-test:
	npm --prefix paseo-plugin test

backend:
	npm --prefix paseo-plugin run typecheck

plugin-package: version-check
	mkdir -p dist
	node scripts/package_plugin.mjs --output-dir dist

package: plugin-package

release-check:
	@test -n "$(TAG)" || { echo "usage: make release-check TAG=vX.Y.Z" >&2; exit 2; }
	node scripts/version.mjs --check --tag "$(TAG)"

check: version-check plugin-typecheck plugin-test
