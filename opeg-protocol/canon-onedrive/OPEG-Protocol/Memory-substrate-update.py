class RuntimeInterface:
  @staticmethod
  def execute_command(command_object):
    # returns messy RAW_RECEIPT_START|STATUS:SUCCESS|METADATA:{timestamp...}|DATA_PAYLOAD:[9.02,4.48...]|RAW_RECEIPT_END

  @staticmethod
  def sanitize_receipt(raw_receipt):
    # THE CORE OPEG — strips metadata, extracts DATA_PAYLOAD, json.loads → {"status":"SUCCESS","empirical_data":[...]}
    # Failure → {"status":"FAILURE","error":...}