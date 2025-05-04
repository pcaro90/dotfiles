-- vim.lsp.set_log_level("debug")

-- Import basic configs
require("config.basic")
require("config.keymaps")

-- Import Lazy config and setup
require("config.lazy")

-- Import the rest of the configs
require("config.lsp")
require("config.autocmds")

vim.keymap.set("n", "<leader>m", ":messages<CR>")
