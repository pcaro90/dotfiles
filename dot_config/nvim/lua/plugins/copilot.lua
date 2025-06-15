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
    copilot_model = "gpt-4o-copilot",
  },
}
