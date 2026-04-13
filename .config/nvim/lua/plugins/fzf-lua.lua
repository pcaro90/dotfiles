return {
  "ibhagwan/fzf-lua",
  lazy = true,
  dependencies = {
    "nvim-tree/nvim-web-devicons",
    "nvim-treesitter/nvim-treesitter", -- Needed to get the preview right
  },
  opts = {},
  cmd = {
    "FzfLua",
  },
  keys = {
    { "<leader>f<", "<cmd>FzfLua resume<cr>", desc = "Fzf: Resume last search" },

    { "<leader>fo", "<cmd>FzfLua files<CR>", desc = "Fzf: Open file menu" },
    { "<leader>ff", "<cmd>FzfLua live_grep<cr>", desc = "Fzf: Live search menu" },
    { "<leader>fg", "<cmd>FzfLua git_status<cr>", desc = "Fzf: Git status menu" },
    { "<leader>fb", "<cmd>FzfLua buffers<cr>", desc = "Fzf: Buffers menu" },

    -- { "<leader>fh", "<cmd>FzfLua help_tags<cr>", desc = "Fzf: Help tags menu" },
    -- { "<leader>fr", "<cmd>FzfLua registers<cr>", desc = "Fzf: Registers menu" },
    -- { "<leader>fj", "<cmd>FzfLua jumplist<cr>", desc = "Fzf: Jumplist menu" },
    -- { "<leader>fk", "<cmd>FzfLua keymaps<cr>", desc = "Fzf: Keymaps menu" },
    -- { "<leader>ft", "<cmd>FzfLua tags<cr>", desc = "Fzf: Tags menu" },
    -- { "<leader>fT", "<cmd>FzfLua colorschemes<cr>", desc = "Fzf: Colorschemes menu" },
    --
  },
}
