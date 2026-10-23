document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('chatForm');
    const input = document.getElementById('userInput');
    const messagesArea = document.getElementById('messagesArea');

    form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = input.value.trim();
        if(!text) return;

        addMessage(text, 'user');
        input.value = '';
        
        const typingId = addTypingIndicator();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ prompt: text })
            });
            const data = await response.json();
            
            removeElement(typingId);
            
            // Render the humanly formatted message
            addMessage(data.output || "I couldn't write that right now.", 'agent');

        } catch(err) {
            console.error(err);
            removeElement(typingId);
            addMessage("Hmm, my connection seems to be down at the moment. Can you try again?", 'agent');
        }
    });

    function addMessage(content, sender) {
        const row = document.createElement('div');
        row.className = `message-row ${sender}`;
        
        let avatarHtml = '';
        if (sender === 'agent') {
            avatarHtml = `<img src="https://api.dicebear.com/7.x/bottts/svg?seed=Claw" alt="Agent" class="message-avatar">`;
        }

        row.innerHTML = `
            ${avatarHtml}
            <div class="bubble ${sender}-bubble"></div>
        `;
        
        messagesArea.appendChild(row);
        
        // Safe injection
        row.querySelector('.bubble').textContent = content;
        
        scrollToBottom();
    }

    function addTypingIndicator() {
        const id = 'typing-' + Date.now();
        const row = document.createElement('div');
        row.className = `message-row agent`;
        row.id = id;
        row.innerHTML = `
            <img src="https://api.dicebear.com/7.x/bottts/svg?seed=Claw" alt="Agent" class="message-avatar">
            <div class="bubble agent-bubble typing">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        messagesArea.appendChild(row);
        scrollToBottom();
        return id;
    }

    function removeElement(id) {
        const el = document.getElementById(id);
        if(el) el.remove();
    }

    function scrollToBottom() {
        const container = document.getElementById('chatContainer');
        container.scrollTop = container.scrollHeight;
    }
});
