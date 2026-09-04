package expo.modules.t3terminal

import expo.modules.kotlin.records.Field
import expo.modules.kotlin.records.Record

/**
 * One delivery from JS: the slice appended since [cursor] last advanced, or a
 * full replay that replaces whatever the terminal currently holds. A view
 * ignores an append whose cursor it already passed, so a prop resend is
 * harmless.
 */
class TerminalAppend : Record {
  @Field
  val reset: Boolean = false

  @Field
  val chunk: String = ""

  @Field
  val cursor: Double = -1.0

  @Field
  val epoch: Double = -1.0
}
