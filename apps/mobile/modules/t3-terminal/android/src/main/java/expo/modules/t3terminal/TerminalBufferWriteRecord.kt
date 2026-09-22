package expo.modules.t3terminal

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * One incremental terminal write from JS: [seq] orders and deduplicates the
 * writes, [reset] clears the grid before [data] is fed.
 *
 */
class TerminalBufferWriteRecord : Record {
  @Field
  var seq: Int = 0

  @Field
  var reset: Boolean = false

  @Field
  var data: String = ""
}
