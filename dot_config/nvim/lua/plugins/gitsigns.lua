return {
  "lewis6991/gitsigns.nvim",
  event = { "BufReadPre", "BufNewFile" },
  keys = {
    { "[g", "<cmd>Gitsigns prev_hunk<CR>", desc = "Git: Previous hunk" },
    { "]g", "<cmd>Gitsigns next_hunk<CR>", desc = "Git: Next hunk" },
    { "<leader>gp", "<cmd>Gitsigns preview_hunk<CR>", desc = "Git: Preview hunk" },

    { "<leader>gs", "<cmd>Gitsigns stage_hunk<CR>", desc = "Git: Stage hunk" },
    { "<leader>gr", "<cmd>Gitsigns reset_hunk<CR>", desc = "Git: Reset hunk" },

    { "<leader>gS", "<cmd>Gitsigns stage_buffer<CR>", desc = "Git: Stage buffer" },
    { "<leader>gR", "<cmd>Gitsigns reset_buffer<CR>", desc = "Git: Reset buffer" },

    { "<leader>gb", "<cmd>Gitsigns blame_line<CR>", desc = "Git: Blame line" },
  },
}
