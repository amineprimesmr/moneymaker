package io.moneymaker

import com.sun.net.httpserver.HttpServer
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import java.net.InetSocketAddress
import java.util.concurrent.atomic.AtomicInteger

class ApiTest {
    private lateinit var server: HttpServer
    private val hits = AtomicInteger()
    @Volatile private var status = 200
    @Volatile private var body = "{}"

    @Before fun start() {
        server = HttpServer.create(InetSocketAddress("127.0.0.1", 0), 0)
        server.createContext("/v1/") { ex ->
            hits.incrementAndGet()
            val bytes = body.toByteArray()
            ex.sendResponseHeaders(status, if (bytes.isEmpty()) -1 else bytes.size.toLong())
            if (bytes.isNotEmpty()) ex.responseBody.use { it.write(bytes) }
            ex.close()
        }
        server.start()
    }

    @After fun stop() = server.stop(0)

    private fun api() = Api("http://127.0.0.1:${server.address.port}/v1", "mm_pub_test", retryDelayMs = 1)

    private fun fails(block: suspend () -> Unit): MoneyMakerException = try {
        runBlocking { block() }; fail("expected MoneyMakerException"); throw AssertionError()
    } catch (e: MoneyMakerException) { e }

    @Test fun returnsJsonOnSuccess() = runBlocking {
        body = """{"current":"default","offerings":{}}"""
        assertEquals("default", api().get("offerings").getString("current"))
    }

    @Test fun clientErrorIsTypedAndNotRetried() {
        status = 401; body = """{"error":"invalid_api_key","message":"bad key"}"""
        val e = fails { api().get("offerings") }
        assertEquals("invalid_api_key", e.code)
        assertEquals(401, e.status)
        assertFalse(e.isRetryable)
        assertEquals(1, hits.get())
    }

    @Test fun every5xxIsRetriedThenRetryable() {
        status = 502; body = """{"error":"google_api_error","message":"upstream"}"""
        val e = fails { api().get("customers/u") }
        assertEquals("google_api_error", e.code)
        assertEquals(502, e.status)
        assertTrue(e.isRetryable)
        assertTrue(isRetryable(e))
        assertEquals(3, hits.get())
    }

    @Test fun nonJson5xxGetsHttpCode() {
        status = 503; body = "Service Unavailable"
        val e = fails { api().get("offerings") }
        assertEquals("http_503", e.code)
        assertTrue(e.isRetryable)
    }

    @Test fun invalidJsonOnSuccessIsAnError() {
        status = 200; body = "<html>not json</html>"
        val e = fails { api().get("offerings") }
        assertEquals("invalid_response", e.code)
        assertFalse(e.isRetryable)
    }

    @Test fun networkFailureIsRetryable() {
        val port = server.address.port
        server.stop(0)
        val e = fails { Api("http://127.0.0.1:$port/v1", "k", retryDelayMs = 1).get("offerings") }
        assertEquals("network", e.code)
        assertTrue(e.isRetryable)
    }

    @Test fun tooManyRequestsIsRetryableButNotRetriedInline() {
        status = 429; body = """{"error":"rate_limited"}"""
        val e = fails { api().get("offerings") }
        assertTrue(e.isRetryable)
        assertEquals(1, hits.get())
    }
}
