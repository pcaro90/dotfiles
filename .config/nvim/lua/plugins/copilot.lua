return {
  "zbirenbaum/copilot.lua",
  event = { "InsertEnter" },
  opts = {
    suggestion = {
      enabled = false,
      auto_trigger = true,
      keymap = {
        accept = false, -- handled by blink.cmp
      },
    },
    panel = {
      enabled = false,
    },
    filetypes = {
      yaml = true,
    },
  },
}
