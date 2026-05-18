package expo.modules.spotlightslabscanner

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Rect
import android.net.Uri
import com.google.mlkit.vision.barcode.BarcodeScanner
import com.google.mlkit.vision.barcode.BarcodeScannerOptions
import com.google.mlkit.vision.barcode.BarcodeScanning
import com.google.mlkit.vision.barcode.common.Barcode
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.text.Text
import com.google.mlkit.vision.text.TextRecognition
import com.google.mlkit.vision.text.TextRecognizer
import com.google.mlkit.vision.text.latin.TextRecognizerOptions
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import java.net.URI
import java.net.URLDecoder

private class InvalidImageUriException(message: String) :
  CodedException("InvalidImageUri", message, null)

private class ImageLoadFailedException(message: String, cause: Throwable? = null) :
  CodedException("ImageLoadFailed", message, cause)

private class TextRecognitionFailedException(message: String, cause: Throwable? = null) :
  CodedException("TextRecognitionFailed", message, cause)

private class BarcodeScanningFailedException(message: String, cause: Throwable? = null) :
  CodedException("BarcodeScanningFailed", message, cause)

class SpotlightSlabScannerModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("SpotlightSlabScanner")

    AsyncFunction("scanPSALabel") Coroutine { imageUri: String ->
      scanPSALabelInternal(imageUri)
    }

    AsyncFunction("quickClassifyCapture") Coroutine { imageUri: String ->
      quickClassifyCaptureInternal(imageUri)
    }
  }

  private suspend fun scanPSALabelInternal(imageUri: String): Map<String, Any?> {
    val bitmap = withContext(Dispatchers.IO) { loadBitmap(imageUri) }
    val width = bitmap.width
    val height = bitmap.height
    val inputImage = InputImage.fromBitmap(bitmap, 0)

    return coroutineScope {
      val textBlocksDeferred = async(Dispatchers.IO) { recognizeText(inputImage) }
      val barcodesDeferred = async(Dispatchers.IO) { scanBarcodes(inputImage) }

      val textBlocks = textBlocksDeferred.await()
      val barcodes = barcodesDeferred.await()

      mapOf(
        "width" to width,
        "height" to height,
        "textBlocks" to textBlocks,
        "barcodes" to barcodes,
      )
    }
  }

  // MARK: - URI handling

  private fun loadBitmap(imageUri: String): Bitmap {
    val trimmed = imageUri.trim()
    if (trimmed.isEmpty()) {
      throw InvalidImageUriException("Expected a non-empty local image URI.")
    }

    val context = appContext.reactContext
      ?: throw ImageLoadFailedException("React context unavailable while decoding image.")

    val bitmap: Bitmap? = try {
      when {
        trimmed.startsWith("file://") -> {
          val path = uriToFilePath(trimmed)
            ?: throw InvalidImageUriException("Could not parse file path from URI: $trimmed")
          BitmapFactory.decodeFile(path)
        }
        trimmed.startsWith("content://") -> {
          context.contentResolver.openInputStream(Uri.parse(trimmed)).use { stream ->
            if (stream == null) {
              throw ImageLoadFailedException("Could not open content URI: $trimmed")
            }
            BitmapFactory.decodeStream(stream)
          }
        }
        trimmed.startsWith("/") -> BitmapFactory.decodeFile(trimmed)
        else -> {
          // Last-resort: try percent-decoding to a path.
          val decoded = try {
            URLDecoder.decode(trimmed, "UTF-8")
          } catch (_: IllegalArgumentException) {
            null
          }
          if (decoded != null && decoded.startsWith("/")) {
            BitmapFactory.decodeFile(decoded)
          } else {
            throw InvalidImageUriException(
              "Only local file://, content://, or absolute path image URIs are supported."
            )
          }
        }
      }
    } catch (e: CodedException) {
      throw e
    } catch (e: Throwable) {
      throw ImageLoadFailedException(
        "Could not decode image at $trimmed: ${e.localizedMessage ?: e.javaClass.simpleName}",
        e
      )
    }

    return bitmap
      ?: throw ImageLoadFailedException("BitmapFactory returned null for $trimmed.")
  }

  private fun uriToFilePath(fileUri: String): String? {
    // Try the standard URI parser first. `file:///path/to/x` -> path = "/path/to/x".
    val viaUri: String? = try {
      val parsed = URI(fileUri)
      parsed.path?.takeIf { it.isNotEmpty() }
    } catch (_: Throwable) {
      null
    }

    val resolved: String? = viaUri ?: try {
      // Fallback: strip the scheme manually and percent-decode.
      URLDecoder.decode(fileUri.removePrefix("file://"), "UTF-8")
    } catch (_: Throwable) {
      null
    }

    // Tolerate the rare case where stripping leaves a relative-looking path.
    return resolved?.let { if (it.startsWith("/")) it else "/$it" }
  }

  // MARK: - Text recognition

  private suspend fun recognizeText(image: InputImage): List<Map<String, Any?>> {
    val recognizer: TextRecognizer = TextRecognition.getClient(TextRecognizerOptions.DEFAULT_OPTIONS)
    val result: Text = try {
      recognizer.process(image).await()
    } catch (e: Throwable) {
      throw TextRecognitionFailedException(
        "ML Kit text recognition failed: ${e.localizedMessage ?: e.javaClass.simpleName}",
        e
      )
    }
    return makeTextBlocks(result)
  }

  private fun makeTextBlocks(result: Text): List<Map<String, Any?>> {
    val blocks: List<Map<String, Any?>> = result.textBlocks.mapNotNull { block ->
      val text = block.text
      if (text.trim().isEmpty()) {
        return@mapNotNull null
      }
      mapOf(
        "text" to text,
        "boundingBox" to rectToBoundingBox(block.boundingBox),
      )
    }

    // Sort top-to-bottom, then left-to-right within ~6px y tolerance.
    return blocks.sortedWith(Comparator { lhs, rhs ->
      val left = lhs["boundingBox"] as? Map<*, *>
      val right = rhs["boundingBox"] as? Map<*, *>
      val ly = (left?.get("y") as? Number)?.toDouble() ?: 0.0
      val ry = (right?.get("y") as? Number)?.toDouble() ?: 0.0
      val lx = (left?.get("x") as? Number)?.toDouble() ?: 0.0
      val rx = (right?.get("x") as? Number)?.toDouble() ?: 0.0
      if (kotlin.math.abs(ly - ry) < 6.0) {
        lx.compareTo(rx)
      } else {
        ly.compareTo(ry)
      }
    })
  }

  // MARK: - Barcode scanning

  private suspend fun scanBarcodes(image: InputImage): List<Map<String, Any?>> {
    val options = BarcodeScannerOptions.Builder()
      .setBarcodeFormats(
        Barcode.FORMAT_CODE_39,
        Barcode.FORMAT_CODE_93,
        Barcode.FORMAT_CODE_128,
        Barcode.FORMAT_DATA_MATRIX,
        Barcode.FORMAT_EAN_8,
        Barcode.FORMAT_EAN_13,
        Barcode.FORMAT_PDF417,
        Barcode.FORMAT_QR_CODE,
        Barcode.FORMAT_UPC_E,
      )
      .build()
    val scanner: BarcodeScanner = BarcodeScanning.getClient(options)

    val barcodes: List<Barcode> = try {
      scanner.process(image).await()
    } catch (e: Throwable) {
      throw BarcodeScanningFailedException(
        "ML Kit barcode scanning failed: ${e.localizedMessage ?: e.javaClass.simpleName}",
        e
      )
    }

    return makeBarcodes(barcodes)
  }

  private fun makeBarcodes(barcodes: List<Barcode>): List<Map<String, Any?>> {
    return barcodes.mapNotNull { barcode ->
      val raw = barcode.rawValue?.trim()
      if (raw.isNullOrEmpty()) {
        return@mapNotNull null
      }
      mapOf(
        "rawValue" to raw,
        "format" to formatString(barcode.format),
        "boundingBox" to rectToBoundingBox(barcode.boundingBox),
      )
    }
  }

  private fun formatString(format: Int): String {
    return when (format) {
      Barcode.FORMAT_CODE_39 -> "code39"
      Barcode.FORMAT_CODE_93 -> "code93"
      Barcode.FORMAT_CODE_128 -> "code128"
      Barcode.FORMAT_DATA_MATRIX -> "dataMatrix"
      Barcode.FORMAT_EAN_8 -> "ean8"
      Barcode.FORMAT_EAN_13 -> "ean13"
      Barcode.FORMAT_PDF417 -> "pdf417"
      Barcode.FORMAT_QR_CODE -> "qr"
      Barcode.FORMAT_UPC_E -> "upce"
      Barcode.FORMAT_UPC_A -> "upca"
      Barcode.FORMAT_CODABAR -> "codabar"
      Barcode.FORMAT_ITF -> "itf"
      Barcode.FORMAT_AZTEC -> "aztec"
      Barcode.FORMAT_ALL_FORMATS -> "all"
      Barcode.FORMAT_UNKNOWN -> "unknown"
      else -> "unknown"
    }
  }

  // MARK: - Bounding box helpers
  //
  // ML Kit on Android reports `boundingBox` already in pixel coordinates with
  // origin at the top-left and the y-axis growing downward. That matches the
  // coordinate system the iOS modules expose, so we pass through unchanged.

  private fun rectToBoundingBox(rect: Rect?): Map<String, Any?>? {
    if (rect == null) {
      return null
    }
    return mapOf(
      "x" to rect.left,
      "y" to rect.top,
      "width" to rect.width(),
      "height" to rect.height(),
    )
  }

  // MARK: - Quick classify capture

  private suspend fun quickClassifyCaptureInternal(imageUri: String): Map<String, Any?> {
    val decodeStart = System.currentTimeMillis()

    // Load with inSampleSize=4 for fast decode (plenty of resolution for hue/edge sampling)
    val bitmap = withContext(Dispatchers.IO) {
      val opts = BitmapFactory.Options().apply { inSampleSize = 4 }
      loadBitmapWithOptions(imageUri, opts)
    }

    // Downsample to ~400px long-side
    val smallBitmap = downsample(bitmap, targetLongSide = 400)

    val classifyStart = System.currentTimeMillis()
    val decodeMs = (classifyStart - decodeStart).toDouble()

    val width = smallBitmap.width
    val height = smallBitmap.height

    // Red band: top 18% strip
    val redBandScore = computeRedBandScore(smallBitmap, width, height)

    // Barcode region: bottom 12% strip — edge density
    val barcodeRegionScore = computeBarcodeRegionScore(smallBitmap, width, height)

    val isSlabLikely = redBandScore > 0.45 && barcodeRegionScore > 0.40
    val confidence = redBandScore * 0.6 + barcodeRegionScore * 0.4
    val classifyMs = (System.currentTimeMillis() - classifyStart).toDouble()

    return mapOf(
      "isSlabLikely" to isSlabLikely,
      "confidence" to confidence,
      "redBandScore" to redBandScore,
      "barcodeRegionScore" to barcodeRegionScore,
      "decodeMs" to decodeMs,
      "classifyMs" to classifyMs,
    )
  }

  private fun loadBitmapWithOptions(imageUri: String, opts: BitmapFactory.Options): Bitmap {
    val trimmed = imageUri.trim()
    if (trimmed.isEmpty()) throw InvalidImageUriException("Expected a non-empty local image URI.")
    val context = appContext.reactContext ?: throw ImageLoadFailedException("React context unavailable.")
    val bitmap: Bitmap? = when {
      trimmed.startsWith("file://") -> {
        val path = uriToFilePath(trimmed) ?: throw InvalidImageUriException("Could not parse file path: $trimmed")
        BitmapFactory.decodeFile(path, opts)
      }
      trimmed.startsWith("content://") -> {
        context.contentResolver.openInputStream(Uri.parse(trimmed)).use { stream ->
          stream?.let { BitmapFactory.decodeStream(it, null, opts) }
            ?: throw ImageLoadFailedException("Could not open content URI: $trimmed")
        }
      }
      trimmed.startsWith("/") -> BitmapFactory.decodeFile(trimmed, opts)
      else -> {
        val decoded = try { URLDecoder.decode(trimmed, "UTF-8") } catch (_: Throwable) { null }
        if (decoded != null && decoded.startsWith("/")) BitmapFactory.decodeFile(decoded, opts)
        else throw InvalidImageUriException("Only local file://, content://, or absolute path URIs supported.")
      }
    }
    return bitmap ?: throw ImageLoadFailedException("BitmapFactory returned null for $trimmed.")
  }

  private fun downsample(src: Bitmap, targetLongSide: Int): Bitmap {
    val longSide = maxOf(src.width, src.height)
    if (longSide <= targetLongSide) return src
    val scale = targetLongSide.toFloat() / longSide
    val w = (src.width * scale).toInt().coerceAtLeast(1)
    val h = (src.height * scale).toInt().coerceAtLeast(1)
    return Bitmap.createScaledBitmap(src, w, h, true)
  }

  private fun computeRedBandScore(bmp: Bitmap, width: Int, height: Int): Double {
    val stripHeight = (height * 0.18).toInt().coerceAtLeast(1)
    var redCount = 0
    var total = 0
    for (y in 0 until stripHeight) {
      for (x in 0 until width) {
        val pixel = bmp.getPixel(x, y)
        val r = android.graphics.Color.red(pixel) / 255.0
        val g = android.graphics.Color.green(pixel) / 255.0
        val b = android.graphics.Color.blue(pixel) / 255.0
        val (h, s, v) = rgbToHSV(r, g, b)
        if ((h >= 350.0 || h <= 10.0) && s >= 0.6 && v >= 0.4) redCount++
        total++
      }
    }
    return if (total == 0) 0.0 else redCount.toDouble() / total
  }

  private fun computeBarcodeRegionScore(bmp: Bitmap, width: Int, height: Int): Double {
    val stripStart = (height * 0.88).toInt()
    val stripEnd = height
    var magnitudeSum = 0.0
    var count = 0
    for (y in stripStart until (stripEnd - 1)) {
      for (x in 0 until (width - 1)) {
        val gray00 = toGray(bmp.getPixel(x, y))
        val gray10 = toGray(bmp.getPixel(x + 1, y))
        val gray01 = toGray(bmp.getPixel(x, y + 1))
        val gx = kotlin.math.abs(gray10 - gray00)
        val gy = kotlin.math.abs(gray01 - gray00)
        magnitudeSum += (gx + gy) / 2.0 / 255.0
        count++
      }
    }
    return if (count == 0) 0.0 else magnitudeSum / count
  }

  private fun toGray(pixel: Int): Double {
    val r = android.graphics.Color.red(pixel).toDouble()
    val g = android.graphics.Color.green(pixel).toDouble()
    val b = android.graphics.Color.blue(pixel).toDouble()
    return 0.299 * r + 0.587 * g + 0.114 * b
  }

  private fun rgbToHSV(r: Double, g: Double, b: Double): Triple<Double, Double, Double> {
    val maxC = maxOf(r, g, b)
    val minC = minOf(r, g, b)
    val delta = maxC - minC
    val v = maxC
    val s = if (maxC == 0.0) 0.0 else delta / maxC
    var h = 0.0
    if (delta > 0.0) {
      h = when (maxC) {
        r -> 60.0 * (((g - b) / delta) % 6.0)
        g -> 60.0 * ((b - r) / delta + 2.0)
        else -> 60.0 * ((r - g) / delta + 4.0)
      }
    }
    if (h < 0) h += 360.0
    return Triple(h, s, v)
  }
}
