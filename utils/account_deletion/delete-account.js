const deleteButton = document.getElementById("delete-button");
const cancelButton = document.getElementById("cancel-button");

const confirmModal = document.getElementById("confirmModal");
const cancelDelete = document.getElementById("cancelDelete");
const confirmDelete = document.getElementById("confirmDelete");

const resultModal = document.getElementById("resultModal");
const resultIcon = document.getElementById("resultIcon");
const resultTitle = document.getElementById("resultTitle");
const resultMessage = document.getElementById("resultMessage");
const closeResultModal = document.getElementById("closeResultModal");

function showPopup(title, message, success = false) {

    resultTitle.innerHTML = title;

    resultMessage.innerHTML = message;

    resultIcon.innerHTML = success ? "✅" : "❌";

    closeResultModal.style.background = success
        ? "#28a745"
        : "#dc3545";

    resultModal.style.display = "flex";
}

closeResultModal.onclick = () => {

    resultModal.style.display = "none";

    if (resultTitle.innerHTML === "Account Deleted Successfully") {

        window.location.href = "/";

    }

};

cancelButton.onclick = () => {

    window.history.back();

};

deleteButton.onclick = () => {

    const identifier = document
        .getElementById("identifier")
        .value
        .trim();

    if (!identifier) {

        showPopup(
            "Missing Information",
            "Please enter your registered email address or mobile number."
        );

        return;

    }

    confirmModal.style.display = "flex";

};

cancelDelete.onclick = () => {

    confirmModal.style.display = "none";

};

confirmDelete.onclick = async () => {

    confirmModal.style.display = "none";

    const identifier = document
        .getElementById("identifier")
        .value
        .trim();

    try {

        const res = await fetch("/request/delete-account", {

            method: "POST",

            headers: {
                "Content-Type": "application/json"
            },

            body: JSON.stringify({
                identifier
            })

        });

        const data = await res.json();

        if (data.success) {

            showPopup(
                "Account Deleted Successfully",
                "Your Cerca Cars account has been permanently deleted.<br><br>All associated personal information, ride history, saved addresses, payment methods and wallet data have been removed.<br><br>Thank you for using Cerca Cars.",
                true
            );

        } else {

            showPopup(
                "Account Not Found",
                "We couldn't find an account associated with the email address or mobile number you entered.<br><br>Please enter the email address or mobile number that is registered with your Cerca Cars account and try again."
            );

        }

    } catch (err) {

        showPopup(
            "Error",
            "Something went wrong while processing your request.<br><br>Please try again later."
        );

    }

};