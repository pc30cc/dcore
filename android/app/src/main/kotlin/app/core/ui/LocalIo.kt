package app.core.ui

import androidx.compose.runtime.staticCompositionLocalOf
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.Dispatchers

/**
 * Where a composable does its file reads (a raw resource, a cached file):
 * the IO pool. A Robolectric test, whose resources are only safe to read on
 * the main thread, provides that thread here.
 */
val LocalIoDispatcher = staticCompositionLocalOf<CoroutineDispatcher> { Dispatchers.IO }
