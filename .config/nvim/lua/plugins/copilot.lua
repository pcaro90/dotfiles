return {
  "zbirenbaum/copilot.lua",
  event = { "InsertEnter" },
  opts = {
    suggestion = {
      enabled = true,
      auto_trigger = true,
      keymap = {
        accept = "<C-CR>",
      },
    },
    panel = {
      enabled = false,
    },
    filetypes = {
      yaml = true,
    },
    -- copilot_model = "gpt-4o-copilot",
  },
}
