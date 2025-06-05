return {
  "zbirenbaum/copilot.lua",
  event = { "InsertEnter" },
  opts = {
    suggestion = {
      enabled = true,
      auto_trigger = true,
      keymap = {
        accept = "<S-Tab>",
      },
    },
    panel = {
      enabled = false,
    },
    copilot_model = "gpt-4o-copilot",
  },
}
