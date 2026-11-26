package app.core.feature.match

import app.core.model.OwnPhoto
import app.core.model.Photo
import app.core.model.PhotoStatus
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

/** Which of the account's own photos the match moment shows, from every state a photo can be in. */
class MatchPhotoTest {

    private val copies = mutableMapOf<String, File>()
    private fun pick(vararg photos: OwnPhoto) = ownMatchPhoto(photos.toList()) { id -> copies[id] }
    private fun url(id: String) = "https://media.test/p/$id/1/640.webp"

    @Test
    fun anApprovedPhotoWinsOverAnEarlierOneInReview() {
        val photo = pick(
            OwnPhoto("1", 0, PhotoStatus.Review, url = url("1")),
            OwnPhoto("2", 1, PhotoStatus.Approved, w = 640, h = 800, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = url("2")),
        )
        assertEquals(MatchPhoto.Remote(Photo("2", 640, 800, "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url("2")), approved = true), photo)
    }

    @Test
    fun aPhotoInReviewIsTheServersCopyNotYetFinal() {
        val photo = pick(OwnPhoto("1", 0, PhotoStatus.Review, url = url("1")))
        assertEquals(MatchPhoto.Remote(Photo("1", url = url("1")), approved = false), photo)
        assertFalse(photo.isFinal)
    }

    @Test
    fun aPhotoStillProcessingIsThePhonesOwnUpload() {
        val upload = File("x.jpg")
        copies["3"] = upload
        assertEquals(MatchPhoto.PhoneCopy("3", upload), pick(OwnPhoto("3", 0, PhotoStatus.Processing, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj")))
    }

    @Test
    fun withoutAnUploadAProcessingPhotoIsItsBlurhashAlone() {
        val photo = pick(OwnPhoto("4", 0, PhotoStatus.Processing, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj"))
        assertEquals(MatchPhoto.Remote(Photo("4", blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = ""), approved = false), photo)
    }

    @Test
    fun rejectedPhotosAndNoPhotosShowNothing() {
        copies["5"] = File("x.jpg")
        assertNull(pick(OwnPhoto("5", 0, PhotoStatus.Rejected, blurhash = "LEHV6nWB2yk8pyo0adR*.7kCMdnj", url = url("5"))))
        assertNull(pick())
        assertNull("nothing to draw", pick(OwnPhoto("6", 0, PhotoStatus.Processing)))
    }

    @Test
    fun theFirstInTheAccountsOrderIsShown() {
        val photo = pick(
            OwnPhoto("8", 2, PhotoStatus.Approved, url = url("8")),
            OwnPhoto("7", 1, PhotoStatus.Approved, url = url("7")),
        )
        assertEquals("7", photo?.id)
    }

    @Test
    fun onlyAnApprovedServerCopyIsFinal() {
        assertTrue(MatchPhoto.Remote(Photo("1", url = url("1"))).isFinal)
        assertFalse(MatchPhoto.Remote(Photo("1", url = url("1")), approved = false).isFinal)
        assertFalse(MatchPhoto.PhoneCopy("1", File("x.jpg")).isFinal)
        assertFalse((null as MatchPhoto?).isFinal)
    }
}
