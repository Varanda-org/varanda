package app.varanda.cameracapture

import androidx.core.content.FileProvider

// A subclass so the manifest merger keeps this provider apart from every
// other androidx FileProvider in the app.
class CaptureFileProvider : FileProvider()
