package dev.paseo.pocket

import org.junit.Assert.*
import org.junit.Test

class PageOriginTest {
    @Test fun storesOnlySafeSameOriginRoutes() {
        assertEquals("/h/server/agent/id", PageOrigin.safeRestorePath("${PageOrigin.BASE}/h/server/agent/id"))
        for (url in listOf("http://${PageOrigin.HOST}/", "${PageOrigin.BASE}:443/", "https://other.test/",
            "${PageOrigin.BASE}/?token=secret", "${PageOrigin.BASE}/#pairing", "${PageOrigin.BASE}/_expo/index.js"))
            assertNull(url, PageOrigin.safeRestorePath(url))
    }
    @Test fun resourcePathsCannotEscapeTheBundle() {
        for (path in listOf("../secret", "a/../b", "a\\b", "a//b", "a/./b", "a\u0000b"))
            assertNull(path, PageOrigin.resourcePath(path))
        assertEquals("_expo/file.js", PageOrigin.resourcePath("/_expo/file.js"))
    }
}
